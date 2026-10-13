import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { DingTalkStandalone } from "./verticals/finance/pages/DingTalkStandalone";

const root = document.getElementById("root");
if (!root) throw new Error("找不到情报页面容器");
createRoot(root).render(<StrictMode><DingTalkStandalone /></StrictMode>);
