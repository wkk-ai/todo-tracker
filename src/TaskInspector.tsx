import { useEffect, useRef, useState } from "react";
import type { Data, Task } from "./logic";
import type { TaskAction } from "./db";
import { TaskDetails } from "./TaskDetails";
import "./task-inspector.css";

export function TaskInspector({ task, data, today, onAction, onClose }: {
  task: Task; data: Data; today: string; onAction: (action: TaskAction) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(task.title);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { setTitle(task.title); }, [task.title]);
  return <dialog ref={dialog} className="task-inspector" aria-labelledby="task-inspector-title"
    onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-inspector-head"><h2 id="task-inspector-title">Task details</h2><button type="button" onClick={onClose} aria-label="Close task details">Close</button></div>
    <label className="field"><span>Task</span><input value={title} onChange={(event) => setTitle(event.target.value)}
      onBlur={() => { const value = title.trim(); if (value && value !== task.title) onAction({ type: "title", title: value }); else setTitle(task.title); }} /></label>
    <div className="task-inspector-actions"><label className="field"><span>Due date</span><input type="date" value={task.dueOn ?? ""} onChange={(event) => onAction({ type: "due", dueOn: event.target.value || null })} /></label>
      <button className="primary" type="button" onClick={() => onAction({ type: "status", status: task.status === "done" ? "open" : "done" })}>{task.status === "done" ? "Reopen task" : "Mark complete"}</button></div>
    <TaskDetails task={task} today={today} checks={data.checks} tags={data.tags} activity={data.activity}
      attachments={data.attachments} subtasks={data.tasks.filter((item) => item.parentId === task.id)}
      siblings={data.tasks.filter((item) => item.id !== task.id && item.meetingId === task.meetingId)} onAction={onAction} />
  </dialog>;
}
