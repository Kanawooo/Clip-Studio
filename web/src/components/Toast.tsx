import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

export interface ToastState { id: number; message: string; tone: "success" | "error" | "info" }

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose(): void }) {
  if (!toast) return null;
  const Icon = toast.tone === "success" ? CheckCircle2 : toast.tone === "error" ? AlertCircle : Info;
  return <div className={`toast toast-${toast.tone}`} role="status"><Icon size={18} /><span>{toast.message}</span><button className="icon-button" type="button" onClick={onClose} aria-label="关闭提示"><X size={15} /></button></div>;
}
