use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::{Column, Row, TypeInfo, Value as SqlxValue, ValueRef};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_sql::{DbInstances, DbPool};

const DATABASE_KEY: &str = "sqlite:todo-tracker.db";
const TRANSACTION_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const TRANSACTION_SWEEP_INTERVAL: Duration = Duration::from_secs(30);
const RECEIPT_TTL: Duration = Duration::from_secs(300);
const MAX_TRANSACTION_RECEIPTS: usize = 100;
const MAX_SQL_BYTES: usize = 64 * 1024;
const BACKUP_DATABASE_NAME: &str = "database.db";
const BACKUP_MANIFEST_NAME: &str = "manifest.json";
const ALLOWED_WINDOWS: &[&str] = &["main", "person", "card", "focus"];

type SharedTransaction = Arc<Mutex<PendingTransaction>>;

#[derive(Default, Clone)]
pub struct TransactionRegistry {
    transactions: Arc<Mutex<HashMap<String, SharedTransaction>>>,
    receipts: Arc<Mutex<HashMap<String, TransactionReceipt>>>,
}

#[derive(Clone)]
struct TransactionReceipt {
    owner: String,
    status: TransactionStatus,
    recorded_at: Instant,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransactionStatus {
    Committed,
    RolledBack,
    Unknown,
}

struct PendingTransaction {
    owner: String,
    transaction: Option<sqlx::Transaction<'static, sqlx::Sqlite>>,
    last_activity: Instant,
    failed: bool,
    closed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionQueryResult {
    rows_affected: u64,
    last_insert_id: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format_version: u32,
    created_at_unix_seconds: u64,
    requested_name: String,
    database_file: String,
    attachments_directory: String,
    attachment_files: usize,
    attachment_bytes: u64,
}

static BACKUP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn authorized_window(window: &WebviewWindow) -> Result<String, String> {
    let label = window.label();
    if ALLOWED_WINDOWS.contains(&label) {
        Ok(label.to_owned())
    } else {
        Err("This app window cannot edit saved data.".into())
    }
}

async fn database_pool(app: &AppHandle) -> Result<SqlitePool, String> {
    let databases = app.state::<DbInstances>();
    let pools = databases.0.read().await;
    match pools.get(DATABASE_KEY) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        None => Err("Open the app database before saving changes.".into()),
    }
}

fn remove_if_current(
    transactions: &mut HashMap<String, SharedTransaction>,
    token: &str,
    expected: &SharedTransaction,
) {
    if transactions
        .get(token)
        .is_some_and(|current| Arc::ptr_eq(current, expected))
    {
        transactions.remove(token);
    }
}

fn trailing_sql_is_empty_or_comment(bytes: &[u8]) -> bool {
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
        } else if bytes.get(index..index + 2) == Some(b"--") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
        } else if bytes.get(index..index + 2) == Some(b"/*") {
            index += 2;
            let Some(close) = bytes[index..].windows(2).position(|window| window == b"*/") else {
                return false;
            };
            index += close + 2;
        } else {
            return false;
        }
    }
    true
}

fn has_single_sql_statement(query: &str) -> bool {
    let bytes = query.as_bytes();
    let mut index = 0;
    let mut quote = None;
    let mut line_comment = false;
    let mut block_comment = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if line_comment {
            if byte == b'\n' {
                line_comment = false;
            }
            index += 1;
            continue;
        }
        if block_comment {
            if bytes.get(index..index + 2) == Some(b"*/") {
                block_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if let Some(end_quote) = quote {
            if byte == end_quote {
                if bytes.get(index + 1) == Some(&end_quote) {
                    index += 2;
                    continue;
                }
                quote = None;
            }
            index += 1;
            continue;
        }
        if bytes.get(index..index + 2) == Some(b"--") {
            line_comment = true;
            index += 2;
        } else if bytes.get(index..index + 2) == Some(b"/*") {
            block_comment = true;
            index += 2;
        } else if byte == b';' {
            return trailing_sql_is_empty_or_comment(&bytes[index + 1..]);
        } else if byte == b'\'' || byte == b'"' || byte == b'`' {
            quote = Some(byte);
            index += 1;
        } else if byte == b'[' {
            quote = Some(b']');
            index += 1;
        } else {
            index += 1;
        }
    }
    quote.is_none() && !block_comment
}

fn first_sql_keyword(query: &str) -> Option<&str> {
    let bytes = query.as_bytes();
    let mut index = 0;
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if bytes.get(index..index + 2) == Some(b"--") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes.get(index..index + 2) == Some(b"/*") {
            index += 2;
            let close = bytes[index..]
                .windows(2)
                .position(|window| window == b"*/")?;
            index += close + 2;
            continue;
        }
        break;
    }
    let start = index;
    while index < bytes.len() && (bytes[index].is_ascii_alphabetic() || bytes[index] == b'_') {
        index += 1;
    }
    (index > start).then(|| &query[start..index])
}

fn validate_sql(query: &str, allowed: &[&str]) -> Result<(), String> {
    if query.len() > MAX_SQL_BYTES || !has_single_sql_statement(query) {
        return Err("Only one short SQL statement can run per database call.".into());
    }
    let keyword = first_sql_keyword(query).unwrap_or_default();
    if !allowed
        .iter()
        .any(|allowed| keyword.eq_ignore_ascii_case(allowed))
    {
        return Err("This database call only supports ordinary reads and data changes.".into());
    }
    Ok(())
}

fn bind_json_value<'q>(
    statement: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: Value,
) -> Result<sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>, String> {
    match value {
        Value::Null => Ok(statement.bind(None::<String>)),
        Value::Bool(value) => Ok(statement.bind(i64::from(value))),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                Ok(statement.bind(value))
            } else if let Some(value) = number.as_u64() {
                let value = i64::try_from(value)
                    .map_err(|_| "That number is too large for the database.".to_owned())?;
                Ok(statement.bind(value))
            } else if let Some(value) = number.as_f64() {
                Ok(statement.bind(value))
            } else {
                Err("That database value is not a valid number.".into())
            }
        }
        Value::String(value) => Ok(statement.bind(value)),
        Value::Array(_) | Value::Object(_) => Ok(statement.bind(value.to_string())),
    }
}

impl TransactionRegistry {
    async fn find(&self, token: &str) -> Result<SharedTransaction, String> {
        self.transactions
            .lock()
            .await
            .get(token)
            .cloned()
            .ok_or_else(|| "The database transaction expired. Please retry.".into())
    }

    async fn sweep_idle(&self) {
        let candidates: Vec<(String, SharedTransaction)> = self
            .transactions
            .lock()
            .await
            .iter()
            .map(|(token, transaction)| (token.clone(), transaction.clone()))
            .collect();

        for (token, shared) in candidates {
            let receipt = {
                let mut pending = shared.lock().await;
                if pending.closed || pending.last_activity.elapsed() < TRANSACTION_IDLE_TIMEOUT {
                    None
                } else {
                    pending.closed = true;
                    let status = match pending.transaction.take() {
                        Some(transaction) => {
                            if transaction.rollback().await.is_ok() {
                                TransactionStatus::RolledBack
                            } else {
                                TransactionStatus::Unknown
                            }
                        }
                        None => TransactionStatus::RolledBack,
                    };
                    Some((pending.owner.clone(), status))
                }
            };
            if let Some((owner, status)) = receipt {
                self.record_receipt(&token, owner, status).await;
                let mut transactions = self.transactions.lock().await;
                remove_if_current(&mut transactions, &token, &shared);
            }
        }
    }

    async fn rollback_owner(&self, owner: &str) {
        let candidates: Vec<(String, SharedTransaction)> = self
            .transactions
            .lock()
            .await
            .iter()
            .map(|(token, transaction)| (token.clone(), transaction.clone()))
            .collect();

        for (token, shared) in candidates {
            let receipt = {
                let mut pending = shared.lock().await;
                if pending.owner != owner || pending.closed {
                    None
                } else {
                    pending.closed = true;
                    let status = match pending.transaction.take() {
                        Some(transaction) => {
                            if transaction.rollback().await.is_ok() {
                                TransactionStatus::RolledBack
                            } else {
                                TransactionStatus::Unknown
                            }
                        }
                        None => TransactionStatus::RolledBack,
                    };
                    Some((pending.owner.clone(), status))
                }
            };
            if let Some((receipt_owner, status)) = receipt {
                self.record_receipt(&token, receipt_owner, status).await;
                let mut transactions = self.transactions.lock().await;
                remove_if_current(&mut transactions, &token, &shared);
            }
        }
    }

    async fn record_receipt(&self, token: &str, owner: String, status: TransactionStatus) {
        let now = Instant::now();
        let mut receipts = self.receipts.lock().await;
        receipts.retain(|_, receipt| receipt.recorded_at.elapsed() < RECEIPT_TTL);
        if !receipts.contains_key(token) && receipts.len() >= MAX_TRANSACTION_RECEIPTS {
            if let Some(oldest) = receipts
                .iter()
                .min_by_key(|(_, receipt)| receipt.recorded_at)
                .map(|(key, _)| key.clone())
            {
                receipts.remove(&oldest);
            }
        }
        receipts.insert(
            token.to_owned(),
            TransactionReceipt {
                owner,
                status,
                recorded_at: now,
            },
        );
    }

    async fn receipt_status(&self, token: &str, owner: &str) -> Result<TransactionStatus, String> {
        let mut receipts = self.receipts.lock().await;
        receipts.retain(|_, receipt| receipt.recorded_at.elapsed() < RECEIPT_TTL);
        match receipts.get(token) {
            Some(receipt) if receipt.owner == owner => Ok(receipt.status),
            Some(_) => Err("This transaction belongs to another app window.".into()),
            None => Ok(TransactionStatus::Unknown),
        }
    }
}

pub fn start_transaction_cleanup(registry: TransactionRegistry) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TRANSACTION_SWEEP_INTERVAL).await;
            registry.sweep_idle().await;
        }
    });
}

#[tauri::command]
pub async fn begin_database_transaction(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, TransactionRegistry>,
) -> Result<String, String> {
    let owner = authorized_window(&window)?;
    let registry = registry.inner().clone();
    registry.sweep_idle().await;

    let pool = database_pool(&app).await?;
    let transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| "Could not start a safe database update. Please retry.".to_owned())?;
    let token = uuid::Uuid::new_v4().to_string();
    let shared = Arc::new(Mutex::new(PendingTransaction {
        owner,
        transaction: Some(transaction),
        last_activity: Instant::now(),
        failed: false,
        closed: false,
    }));
    registry
        .transactions
        .lock()
        .await
        .insert(token.clone(), shared);
    Ok(token)
}

#[tauri::command]
pub async fn transaction_execute(
    window: WebviewWindow,
    registry: State<'_, TransactionRegistry>,
    token: String,
    query: String,
    values: Vec<Value>,
) -> Result<TransactionQueryResult, String> {
    validate_sql(&query, &["INSERT", "UPDATE", "DELETE", "REPLACE"])?;
    let owner = authorized_window(&window)?;
    let registry = registry.inner().clone();
    let shared = registry.find(&token).await?;
    let mut pending = shared.lock().await;
    if pending.owner != owner {
        return Err("This transaction belongs to another app window.".into());
    }
    if pending.closed || pending.failed {
        return Err("This database transaction is no longer usable.".into());
    }

    let result = {
        let transaction = pending
            .transaction
            .as_mut()
            .ok_or_else(|| "This database transaction is no longer usable.".to_owned())?;
        let mut statement = sqlx::query(&query);
        for value in values {
            statement = bind_json_value(statement, value)?;
        }
        statement.execute(&mut **transaction).await
    };

    match result {
        Ok(result) => {
            pending.last_activity = Instant::now();
            Ok(TransactionQueryResult {
                rows_affected: result.rows_affected(),
                last_insert_id: result.last_insert_rowid(),
            })
        }
        Err(_) => {
            pending.failed = true;
            if let Some(transaction) = pending.transaction.take() {
                let _ = transaction.rollback().await;
            }
            Err("The database update failed and was rolled back.".into())
        }
    }
}

#[tauri::command]
pub async fn transaction_select(
    window: WebviewWindow,
    registry: State<'_, TransactionRegistry>,
    token: String,
    query: String,
    values: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    validate_sql(&query, &["SELECT"])?;
    let owner = authorized_window(&window)?;
    let registry = registry.inner().clone();
    let shared = registry.find(&token).await?;
    let mut pending = shared.lock().await;
    if pending.owner != owner {
        return Err("This transaction belongs to another app window.".into());
    }
    if pending.closed || pending.failed {
        return Err("This database transaction is no longer usable.".into());
    }

    let result = {
        let transaction = pending
            .transaction
            .as_mut()
            .ok_or_else(|| "This database transaction is no longer usable.".to_owned())?;
        let mut statement = sqlx::query(&query);
        for value in values {
            statement = bind_json_value(statement, value)?;
        }
        let rows = statement.fetch_all(&mut **transaction).await;
        rows.and_then(|rows| rows_to_json(rows.as_slice()))
    };

    match result {
        Ok(rows) => {
            pending.last_activity = Instant::now();
            Ok(rows)
        }
        Err(_) => {
            pending.failed = true;
            if let Some(transaction) = pending.transaction.take() {
                let _ = transaction.rollback().await;
            }
            Err("The database read failed and was rolled back.".into())
        }
    }
}

#[tauri::command]
pub async fn finish_database_transaction(
    window: WebviewWindow,
    registry: State<'_, TransactionRegistry>,
    token: String,
    commit: bool,
) -> Result<(), String> {
    let owner = authorized_window(&window)?;
    let registry = registry.inner().clone();
    let Some(shared) = registry.transactions.lock().await.get(&token).cloned() else {
        let status = registry.receipt_status(&token, &owner).await?;
        return if !commit || status == TransactionStatus::Committed {
            Ok(())
        } else {
            Err("The database transaction did not commit. Please retry.".into())
        };
    };

    let (result, status) = {
        let mut pending = shared.lock().await;
        if pending.owner != owner {
            return Err("This transaction belongs to another app window.".into());
        }
        if pending.closed {
            if pending.failed || !commit {
                (Ok(()), TransactionStatus::RolledBack)
            } else {
                (
                    Err("The database transaction expired before it could be saved.".into()),
                    TransactionStatus::RolledBack,
                )
            }
        } else if pending.failed && commit {
            (
                Err("This database transaction failed and was rolled back.".into()),
                TransactionStatus::RolledBack,
            )
        } else {
            pending.closed = true;
            match pending.transaction.take() {
                Some(transaction) if commit => match transaction.commit().await {
                    Ok(()) => (Ok(()), TransactionStatus::Committed),
                    Err(_) => (
                        Err("Could not confirm that the database update finished.".into()),
                        TransactionStatus::Unknown,
                    ),
                },
                Some(transaction) => match transaction.rollback().await {
                    Ok(()) => (Ok(()), TransactionStatus::RolledBack),
                    Err(_) => (
                        Err("Could not confirm that the database update was cancelled.".into()),
                        TransactionStatus::Unknown,
                    ),
                },
                None if !commit => (Ok(()), TransactionStatus::RolledBack),
                None => (
                    Err("The database transaction is no longer usable.".into()),
                    TransactionStatus::Unknown,
                ),
            }
        }
    };

    {
        let mut transactions = registry.transactions.lock().await;
        remove_if_current(&mut transactions, &token, &shared);
    }
    registry.record_receipt(&token, owner, status).await;
    result
}

#[tauri::command]
pub async fn database_transaction_status(
    window: WebviewWindow,
    registry: State<'_, TransactionRegistry>,
    token: String,
) -> Result<TransactionStatus, String> {
    let owner = authorized_window(&window)?;
    let registry = registry.inner().clone();
    if let Some(shared) = registry.transactions.lock().await.get(&token).cloned() {
        if shared.lock().await.owner != owner {
            return Err("This transaction belongs to another app window.".into());
        }
        return Ok(TransactionStatus::Unknown);
    }
    registry.receipt_status(&token, &owner).await
}

pub async fn rollback_transactions_for_window(registry: TransactionRegistry, owner: String) {
    registry.rollback_owner(&owner).await;
}

fn rows_to_json(rows: &[SqliteRow]) -> Result<Vec<Map<String, Value>>, sqlx::Error> {
    let mut output = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = Map::new();
        for (index, column) in row.columns().iter().enumerate() {
            let raw = row.try_get_raw(index)?;
            values.insert(
                column.name().to_owned(),
                sqlite_value_to_json(raw, column.name())?,
            );
        }
        output.push(values);
    }
    Ok(output)
}

fn decode_error<E>(column: &str, source: E) -> sqlx::Error
where
    E: std::error::Error + Send + Sync + 'static,
{
    sqlx::Error::ColumnDecode {
        index: column.to_owned(),
        source: Box::new(source),
    }
}

fn sqlite_value_to_json(
    raw: sqlx::sqlite::SqliteValueRef<'_>,
    column: &str,
) -> Result<Value, sqlx::Error> {
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let type_name = raw.type_info().name().to_owned();
    let value = raw.to_owned();
    let json = match type_name.as_str() {
        "TEXT" => Value::String(
            value
                .try_decode::<String>()
                .map_err(|source| decode_error(column, source))?,
        ),
        "REAL" => {
            let number = value
                .try_decode::<f64>()
                .map_err(|source| decode_error(column, source))?;
            let number = serde_json::Number::from_f64(number).ok_or_else(|| {
                decode_error(
                    column,
                    std::io::Error::other("SQLite returned a non-finite number"),
                )
            })?;
            Value::Number(number)
        }
        "INTEGER" | "NUMERIC" => value
            .try_decode::<i64>()
            .map(|number| Value::Number(number.into()))
            .map_err(|source| decode_error(column, source))?,
        "BOOLEAN" => Value::Bool(
            value
                .try_decode::<bool>()
                .map_err(|source| decode_error(column, source))?,
        ),
        "DATE" => Value::String(
            value
                .try_decode::<sqlx::types::time::Date>()
                .map_err(|source| decode_error(column, source))?
                .to_string(),
        ),
        "TIME" => Value::String(
            value
                .try_decode::<sqlx::types::time::Time>()
                .map_err(|source| decode_error(column, source))?
                .to_string(),
        ),
        "DATETIME" => Value::String(
            value
                .try_decode::<sqlx::types::time::PrimitiveDateTime>()
                .map_err(|source| decode_error(column, source))?
                .to_string(),
        ),
        "BLOB" => {
            let bytes = value
                .try_decode::<Vec<u8>>()
                .map_err(|source| decode_error(column, source))?;
            Value::Array(
                bytes
                    .into_iter()
                    .map(|byte| Value::Number(byte.into()))
                    .collect(),
            )
        }
        "NULL" => Value::Null,
        _ => {
            return Err(sqlx::Error::ColumnDecode {
                index: "unknown".into(),
                source: Box::new(std::io::Error::other(format!(
                    "Unsupported SQLite type: {type_name}"
                ))),
            });
        }
    };
    Ok(json)
}

fn safe_backup_name(name: &str) -> Result<String, String> {
    let clean: String = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "-_.".contains(*character))
        .take(96)
        .collect();
    let clean = clean.trim_matches(['.', '-', '_']);
    if clean.is_empty() {
        return Err("Name the backup.".into());
    }
    Ok(clean.trim_end_matches(".db").to_owned())
}

fn create_backup_directory(root: &Path, base: &str) -> Result<(PathBuf, PathBuf), String> {
    fs::create_dir_all(root).map_err(|_| "Could not create the backup folder.".to_owned())?;
    for _ in 0..32 {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let counter = BACKUP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let unique = format!("{millis}-{}-{counter}", std::process::id());
        let temporary = root.join(format!(".{base}-{unique}.incomplete"));
        let published = root.join(format!("{base}-{unique}"));
        match fs::create_dir(&temporary) {
            Ok(()) => return Ok((temporary, published)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("Could not prepare the backup.".into()),
        }
    }
    Err("Could not reserve a unique backup name.".into())
}

fn copy_attachments(source: &Path, destination: &Path) -> Result<(usize, u64), String> {
    fs::create_dir_all(destination)
        .map_err(|_| "Could not prepare backup attachments.".to_owned())?;
    let source_metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(_) => return Err("Could not inspect saved attachments.".into()),
    };
    if !source_metadata.is_dir() || source_metadata.file_type().is_symlink() {
        return Err("The saved attachments folder is not a regular folder.".into());
    }
    let items = fs::read_dir(source).map_err(|_| "Could not read saved attachments.".to_owned())?;
    let mut count = 0usize;
    let mut total_bytes = 0u64;
    for item in items {
        let item = item.map_err(|_| "Could not list saved attachments.".to_owned())?;
        let file_type = item
            .file_type()
            .map_err(|_| "Could not inspect a saved attachment.".to_owned())?;
        if !file_type.is_file() {
            continue;
        }
        let source_file = item.path();
        let destination_file = destination.join(item.file_name());
        fs::copy(&source_file, &destination_file)
            .map_err(|_| "Could not copy every saved attachment.".to_owned())?;
        let copied_bytes = fs::metadata(&destination_file)
            .map_err(|_| "Could not validate a copied attachment.".to_owned())?
            .len();
        if copied_bytes
            != fs::metadata(&source_file)
                .map_err(|_| "Could not validate a saved attachment.".to_owned())?
                .len()
        {
            return Err("A saved attachment changed while the backup was being made.".into());
        }
        total_bytes = total_bytes.saturating_add(copied_bytes);
        count = count.saturating_add(1);
    }
    Ok((count, total_bytes))
}

async fn remove_partial_backup(directory: PathBuf) {
    let _ = tauri::async_runtime::spawn_blocking(move || fs::remove_dir_all(directory)).await;
}

#[tauri::command]
pub async fn backup_database(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
) -> Result<String, String> {
    authorized_window(&window)?;
    let backup_name = safe_backup_name(&name)?;
    let pool = database_pool(&app).await?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not find the app data folder.".to_owned())?;
    let backups_root = config_dir.join("Backups");
    let (temporary_dir, published_dir) = tauri::async_runtime::spawn_blocking({
        let backups_root = backups_root.clone();
        let backup_name = backup_name.clone();
        move || create_backup_directory(&backups_root, &backup_name)
    })
    .await
    .map_err(|_| "Could not prepare the backup.".to_owned())??;

    let database_path = temporary_dir.join(BACKUP_DATABASE_NAME);
    let database_parameter = database_path.to_string_lossy().into_owned();
    if sqlx::query("VACUUM INTO $1")
        .bind(database_parameter)
        .execute(&pool)
        .await
        .is_err()
    {
        remove_partial_backup(temporary_dir).await;
        return Err("Could not make a consistent database backup. Retry when saves finish.".into());
    }
    let database_check = tauri::async_runtime::spawn_blocking({
        let database_path = database_path.clone();
        move || {
            fs::metadata(database_path)
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false)
        }
    })
    .await;
    if !matches!(database_check, Ok(true)) {
        remove_partial_backup(temporary_dir).await;
        return Err("The database backup could not be verified.".into());
    }

    let attachment_source = config_dir.join("files");
    let attachment_destination = temporary_dir.join("attachments");
    let attachment_result = tauri::async_runtime::spawn_blocking(move || {
        copy_attachments(&attachment_source, &attachment_destination)
    })
    .await;
    let (attachment_files, attachment_bytes) = match attachment_result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            remove_partial_backup(temporary_dir).await;
            return Err(error);
        }
        Err(_) => {
            remove_partial_backup(temporary_dir).await;
            return Err("Could not copy saved attachments.".into());
        }
    };

    let created_at_unix_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let manifest = BackupManifest {
        format_version: 1,
        created_at_unix_seconds,
        requested_name: name,
        database_file: BACKUP_DATABASE_NAME.into(),
        attachments_directory: "attachments".into(),
        attachment_files,
        attachment_bytes,
    };
    let manifest_path = temporary_dir.join(BACKUP_MANIFEST_NAME);
    let manifest_bytes = match serde_json::to_vec_pretty(&manifest) {
        Ok(bytes) => bytes,
        Err(_) => {
            remove_partial_backup(temporary_dir).await;
            return Err("Could not describe the completed backup.".into());
        }
    };
    let write_result =
        tauri::async_runtime::spawn_blocking(move || fs::write(manifest_path, manifest_bytes))
            .await;
    if !matches!(write_result, Ok(Ok(()))) {
        remove_partial_backup(temporary_dir).await;
        return Err("Could not save the backup description.".into());
    }

    let temporary_for_publish = temporary_dir.clone();
    let published_for_publish = published_dir.clone();
    let publish_result = tauri::async_runtime::spawn_blocking(move || {
        fs::rename(&temporary_for_publish, &published_for_publish)
    })
    .await;
    if !matches!(publish_result, Ok(Ok(()))) {
        remove_partial_backup(temporary_dir).await;
        return Err("Could not publish the completed backup.".into());
    }

    Ok(published_dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        RECEIPT_TTL, TransactionReceipt, TransactionRegistry, TransactionStatus,
        has_single_sql_statement, safe_backup_name, validate_sql,
    };
    use serde_json::Value;
    use sqlx::{Connection, Row};

    #[test]
    fn allows_one_read_with_quoted_semicolon_and_trailing_comment() {
        assert!(validate_sql("SELECT 'one; two'; -- done", &["SELECT"]).is_ok());
        assert!(has_single_sql_statement(
            "SELECT [a;b] FROM items; /* done */"
        ));
    }

    #[test]
    fn rejects_multiple_statements_and_transaction_control() {
        let writes = ["INSERT", "UPDATE", "DELETE", "REPLACE"];
        assert!(validate_sql("SELECT 1; DELETE FROM tasks", &["SELECT"]).is_err());
        assert!(validate_sql("COMMIT", &writes).is_err());
        assert!(validate_sql("DELETE FROM tasks; ROLLBACK", &writes).is_err());
    }

    #[test]
    fn accepts_one_data_change_with_trailing_semicolon() {
        let writes = ["INSERT", "UPDATE", "DELETE", "REPLACE"];
        assert!(validate_sql("UPDATE tasks SET title = $1 WHERE id = $2;", &writes).is_ok());
    }

    #[test]
    fn transaction_receipts_report_owner_status_and_expiry() {
        let registry = TransactionRegistry::default();
        tauri::async_runtime::block_on(async {
            assert!(matches!(
                registry.receipt_status("missing", "main").await,
                Ok(TransactionStatus::Unknown)
            ));
            registry
                .record_receipt("saved", "main".into(), TransactionStatus::Committed)
                .await;
            registry
                .record_receipt("saved", "main".into(), TransactionStatus::Committed)
                .await;
            assert!(matches!(
                registry.receipt_status("saved", "main").await,
                Ok(TransactionStatus::Committed)
            ));
            assert!(registry.receipt_status("saved", "person").await.is_err());

            registry.receipts.lock().await.insert(
                "expired".into(),
                TransactionReceipt {
                    owner: "main".into(),
                    status: TransactionStatus::Committed,
                    recorded_at: std::time::Instant::now() - RECEIPT_TTL,
                },
            );
            assert!(matches!(
                registry.receipt_status("expired", "main").await,
                Ok(TransactionStatus::Unknown)
            ));
        });
    }

    #[test]
    fn json_integer_and_boolean_bindings_preserve_sqlite_types() {
        tauri::async_runtime::block_on(async {
            let mut connection = sqlx::SqliteConnection::connect("sqlite::memory:")
                .await
                .unwrap();
            let statement = sqlx::query("SELECT ? AS integer_value, ? AS boolean_value");
            let statement = super::bind_json_value(
                statement,
                Value::Number(serde_json::Number::from(i64::MAX)),
            )
            .unwrap();
            let statement = super::bind_json_value(statement, Value::Bool(true)).unwrap();
            let row = statement.fetch_one(&mut connection).await.unwrap();
            assert_eq!(row.try_get::<i64, _>("integer_value").unwrap(), i64::MAX);
            assert_eq!(row.try_get::<i64, _>("boolean_value").unwrap(), 1);

            let too_large = Value::Number(serde_json::Number::from(u64::MAX));
            assert!(super::bind_json_value(sqlx::query("SELECT ?"), too_large).is_err());
        });
    }

    #[test]
    fn row_decoder_keeps_large_integers_exact_and_nulls_null() {
        tauri::async_runtime::block_on(async {
            let mut connection = sqlx::SqliteConnection::connect("sqlite::memory:")
                .await
                .unwrap();
            let rows = sqlx::query(
                "SELECT 9223372036854775807 AS max_value, 1.5 AS ratio, NULL AS absent",
            )
            .fetch_all(&mut connection)
            .await
            .unwrap();
            let decoded = super::rows_to_json(&rows).unwrap();
            assert_eq!(decoded[0]["max_value"], Value::Number(i64::MAX.into()));
            assert_eq!(decoded[0]["ratio"].as_f64(), Some(1.5));
            assert_eq!(decoded[0]["absent"], Value::Null);
        });
    }

    #[test]
    fn backup_names_cannot_escape_the_backup_folder() {
        assert_eq!(safe_backup_name("../archive.db").unwrap(), "archive");
        assert!(safe_backup_name("...___").is_err());
    }
}
