import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { router } from "./router";
import { loadLlm, saveLlm } from "./lib/llm";
import "./index.css";

// 本地一次性引导：.env.local 提供的 key 只在浏览器还没配置过时写入 localStorage
const bootstrapKey = import.meta.env.VITE_BOOTSTRAP_DEEPSEEK_KEY;
if (bootstrapKey && !loadLlm()) {
  saveLlm({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    apiKey: bootstrapKey,
    model: "deepseek-v4-pro",
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" theme="dark" richColors closeButton duration={3500} />
    </ErrorBoundary>
  </StrictMode>
);
