import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview")) {
  void import("./devPreview").then(({ DevPreview }) => {
    root.render(
      <React.StrictMode>
        <DevPreview />
      </React.StrictMode>,
    );
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
