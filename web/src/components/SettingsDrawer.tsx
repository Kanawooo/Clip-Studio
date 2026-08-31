import { AlertCircle, CheckCircle2, ChevronDown, Eye, EyeOff, LoaderCircle, Search, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { discoverModels, setModelThinkingCapability, testModel } from "../api/tasks.ts";
import {
  capabilityForSettings,
  effectiveModelCapability,
  modelCapabilityFingerprint,
  thinkingCapabilityForSettings,
} from "../state/model-capability.ts";
import type {
  AppSettings,
  DiscoveredModel,
  ModelConfig,
  ModelCatalogItem,
  ModelThinkingLevel,
  ThinkingLevelSetting,
  VisionProbeStatus,
} from "../types/api.ts";
import { RoundedSelect } from "./RoundedSelect.tsx";
import { RoundedMultiSelect } from "./RoundedMultiSelect.tsx";

const THINKING_LEVEL_LABELS: Record<ModelThinkingLevel, string> = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};
const THINKING_LEVEL_ORDER = Object.keys(THINKING_LEVEL_LABELS) as ModelThinkingLevel[];
const THINKING_LEVEL_OPTIONS = THINKING_LEVEL_ORDER.map((level) => ({ value: level, label: THINKING_LEVEL_LABELS[level] }));
const EMPTY_THINKING_LEVELS: ModelThinkingLevel[] = [];
const EMPTY_MODEL_CATALOG: ModelCatalogItem[] = [];
const PROTOCOL_OPTIONS = [
  { value: "openai-completions", label: "OpenAI 兼容" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
];
interface SettingsDrawerProps {
  open: boolean;
  settings: AppSettings;
  modelCatalog?: ModelCatalogItem[];
  onClose(): void;
  onSave(settings: AppSettings): Promise<void> | void;
  onAutoSave(settings: AppSettings): Promise<boolean> | boolean;
  onModelTestSettled?(): void;
  onError(message: string): void;
}

export function SettingsDrawer(props: SettingsDrawerProps) {
  const modelCatalog = props.modelCatalog ?? EMPTY_MODEL_CATALOG;
  const [draft, setDraft] = useState(props.settings);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState<"model" | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [savingThinking, setSavingThinking] = useState(false);
  const [modelListOpen, setModelListOpen] = useState(false);
  const [filterModels, setFilterModels] = useState(false);
  const [activeModelIndex, setActiveModelIndex] = useState(0);
  const [testResult, setTestResult] = useState<{ kind: "model"; text: string; detail?: string } | null>(null);
  const modelComboRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(props.settings);

  useEffect(() => {
    if (props.open) {
      draftRef.current = props.settings;
      setDraft(props.settings);
      setDiscoveredModels([]);
      setModelListOpen(false);
      setFilterModels(false);
      setTestResult(null);
    }
    // Initialize only when the drawer opens. Auto-save updates the parent while
    // the drawer stays open and must not reset its result, model list or scroll.
  }, [props.open]);

  const multimodalCatalog = useMemo(() => modelCatalog.filter((item) =>
    item.input.includes("text") && item.input.includes("image")), [modelCatalog]);
  const providerOptions = useMemo(() => Array.from(new Map(multimodalCatalog.map((item) => [
    item.provider,
    item.providerName,
  ])).entries()).sort((left, right) => left[1].localeCompare(right[1])), [multimodalCatalog]);
  const selectableModels = useMemo<DiscoveredModel[]>(() => draft.modelSource === "builtin"
    ? multimodalCatalog.filter((item) => item.provider === draft.provider).map((item) => ({ id: item.model, name: item.name }))
    : discoveredModels, [multimodalCatalog, discoveredModels, draft.modelSource, draft.provider]);
  const selectedCatalogModel = useMemo(() => draft.modelSource === "builtin"
    ? multimodalCatalog.find((item) => item.provider === draft.provider && item.model === draft.model)
    : undefined, [multimodalCatalog, draft.model, draft.modelSource, draft.provider]);
  const visibleModels = useMemo(() => {
    if (!filterModels) return selectableModels;
    const query = draft.model.trim().toLocaleLowerCase();
    if (!query) return selectableModels;
    return selectableModels.filter((item) => `${item.id}\n${item.name}`.toLocaleLowerCase().includes(query));
  }, [selectableModels, draft.model, filterModels]);
  const modelCapability = effectiveModelCapability(draft);
  const thinkingCapability = thinkingCapabilityForSettings(draft);
  const displayedThinkingCapability = thinkingCapability ?? selectedCatalogModel?.thinking;
  const manualThinkingEditable = displayedThinkingCapability?.status === "unverified"
    || displayedThinkingCapability?.source === "manual";
  const manualThinkingLevels = displayedThinkingCapability?.source === "manual"
    ? displayedThinkingCapability.levels
    : EMPTY_THINKING_LEVELS;
  const thinkingOptions = useMemo(() => [
    { value: "auto", label: "自动（推荐）" },
    ...(displayedThinkingCapability?.status === "supported"
      ? displayedThinkingCapability.levels.map((level) => ({ value: level, label: THINKING_LEVEL_LABELS[level] }))
      : []),
  ], [displayedThinkingCapability]);

  useEffect(() => {
    if (!modelListOpen) return;
    const close = (event: MouseEvent) => {
      if (!modelComboRef.current?.contains(event.target as Node)) setModelListOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [modelListOpen]);
  if (!props.open) return null;

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      draftRef.current = next;
      return next;
    });
  };

  const updateModelIdentity = <K extends "provider" | "baseUrl" | "protocol" | "model">(
    key: K,
    value: AppSettings[K],
  ) => {
    setTestResult(null);
    setDraft((current) => {
      const next = { ...current, [key]: value, modelCapability: null, thinkingLevel: "auto" as const };
      if (current.modelSource === "builtin") {
        if (key === "provider") next.builtinProvider = String(value);
        if (key === "model") next.builtinModel = String(value);
      } else {
        if (key === "provider") next.customProvider = String(value);
        if (key === "model") next.customModel = String(value);
        if (key === "baseUrl") next.customBaseUrl = String(value);
        if (key === "protocol") next.customProtocol = value as AppSettings["customProtocol"];
      }
      draftRef.current = next;
      return next;
    });
  };

  const changeModelSource = (modelSource: AppSettings["modelSource"]) => {
    setTestResult(null);
    setDiscoveredModels([]);
    setModelListOpen(false);
    setFilterModels(false);
    setDraft((current) => {
      const stored = current.modelSource === "builtin"
        ? { ...current, builtinProvider: current.provider, builtinModel: current.model }
        : {
            ...current,
            customProvider: current.provider,
            customModel: current.model,
            customBaseUrl: current.baseUrl,
            customProtocol: current.protocol,
          };
      const next: AppSettings = modelSource === "builtin"
        ? {
            ...stored,
            modelSource,
            provider: stored.builtinProvider,
            model: stored.builtinModel,
            baseUrl: "",
            protocol: "openai-completions",
            modelCapability: null,
            thinkingLevel: "auto",
          }
        : {
            ...stored,
            modelSource,
            provider: stored.customProvider,
            model: stored.customModel,
            baseUrl: stored.customBaseUrl,
            protocol: stored.customProtocol,
            modelCapability: null,
            thinkingLevel: "auto",
          };
      draftRef.current = next;
      return next;
    });
  };

  const changeThinkingLevel = (thinkingLevel: ThinkingLevelSetting) => {
    const next = { ...draftRef.current, thinkingLevel };
    draftRef.current = next;
    setDraft(next);
    void props.onAutoSave(next);
  };

  const modelConfig = (settings: AppSettings): ModelConfig => ({
    provider: settings.provider.trim(),
    model: settings.model.trim(),
    ...(settings.apiKey ? { apiKey: settings.apiKey } : { credentialRef: "main" as const }),
    ...(settings.baseUrl.trim()
      ? {
          baseUrl: settings.baseUrl.trim(),
          protocol: settings.protocol,
          // The probe registers a temporary visual model itself. The saved
          // capability result, not a user-controlled flag, decides task input.
          input: ["text"],
        }
      : {}),
    thinkingLevel: settings.thinkingLevel,
  });

  const runTest = async () => {
    const kind = "model" as const;
    const testedSettings = draftRef.current;
    const testedFingerprint = modelCapabilityFingerprint(testedSettings);
    setTesting(kind);
    setTestResult(null);
    try {
      const result = await testModel(modelConfig(testedSettings));
        const current = draftRef.current;
        if (modelCapabilityFingerprint(current) !== testedFingerprint) {
          setTestResult({
            kind,
            text: "连接成功，但模型设置已经改变",
            detail: "请重新测试当前填写的模型后再开始任务。",
          });
          return;
        }
        const status = result.vision?.status ?? "inconclusive";
        const thinking = result.thinking ?? {
          status: "unverified" as const,
          levels: [],
          source: "unverified" as const,
          message: "思考强度暂时无法确认",
        };
        const retainedThinkingLevel = current.thinkingLevel !== "auto"
          && thinking.status === "supported"
          && thinking.levels.includes(current.thinkingLevel)
          ? current.thinkingLevel
          : "auto";
        const next: AppSettings = {
          ...current,
          thinkingLevel: retainedThinkingLevel,
          modelCapability: {
            fingerprint: testedFingerprint,
            status,
            testedAt: result.testedAt ?? new Date().toISOString(),
            capabilityId: result.capabilityId,
            thinking,
          },
        };
        draftRef.current = next;
        setDraft(next);
        const saved = await props.onAutoSave(next);
        setTestResult({
          kind,
          text: `连接成功${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}${saved ? " · 已自动保存" : ""}`,
          detail: [result.vision?.message, thinking.message].filter(Boolean).join(" · "),
        });
        return;
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setTesting(null);
      props.onModelTestSettled?.();
    }
  };

  const runDiscovery = async () => {
    if (draft.modelSource !== "custom") return;
    if (!draft.baseUrl.trim() || (!draft.apiKey.trim() && !draft.mainKeyStored)) {
      props.onError("请先填写 Base URL 和 API Key");
      return;
    }
    setDiscovering(true);
    setDiscoveredModels([]);
    try {
      const result = await discoverModels({
        baseUrl: draft.baseUrl.trim(),
        protocol: draft.protocol,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : { credentialRef: "main" as const }),
      });
      setDiscoveredModels(result.models);
      setFilterModels(false);
      setActiveModelIndex(0);
      setModelListOpen(result.models.length > 0);
      if (result.models.length === 0) props.onError("服务没有返回可用模型，可以继续手动填写");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "无法获取模型列表");
    } finally {
      setDiscovering(false);
    }
  };

  const saveManualThinking = async (levels: string[]) => {
    const current = draftRef.current;
    const capability = capabilityForSettings(current);
    if (!capability?.capabilityId) {
      props.onError("请先测试当前模型，再手动设置可用档位");
      return;
    }
    if (levels.length === 0) {
      props.onError("请至少选择一个确认可用的思考档位");
      return;
    }
    const selectedLevels = THINKING_LEVEL_ORDER.filter((level) => levels.includes(level));
    setSavingThinking(true);
    try {
      const result = await setModelThinkingCapability({
        capabilityId: capability.capabilityId,
        model: modelConfig(current),
        levels: selectedLevels,
      });
      if (!result.thinking) throw new Error("服务没有返回思考档位结果");
      const retainedThinkingLevel = current.thinkingLevel !== "auto"
        && result.thinking.levels.includes(current.thinkingLevel)
        ? current.thinkingLevel
        : "auto";
      const next: AppSettings = {
        ...current,
        thinkingLevel: retainedThinkingLevel,
        modelCapability: { ...capability, thinking: result.thinking },
      };
      draftRef.current = next;
      setDraft(next);
      await props.onAutoSave(next);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "无法保存思考档位");
    } finally {
      setSavingThinking(false);
    }
  };

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="drawer-header">
          <div className="drawer-title"><span><Settings2 size={18} /></span><div><p className="eyebrow">设置</p><h2 id="settings-title">模型设置</h2></div></div>
          <button className="icon-button" type="button" onClick={props.onClose} aria-label="关闭设置"><X size={18} /></button>
        </header>

        <div className="drawer-body">
          <section className="settings-section">
            <div className="settings-section-title"><h3>主模型</h3><p>负责理解要求、做出剪辑判断并完成任务。</p></div>
            <div className="model-recommendation"><Eye size={18} /><span><strong>仅支持多模态主模型</strong><small>主模型需要直接理解参考画面和素材，并完成剪辑判断。</small></span></div>

            <div className="model-source-switch" role="group" aria-label="模型来源">
              <button type="button" className={draft.modelSource === "builtin" ? "active" : ""} aria-pressed={draft.modelSource === "builtin"} onClick={() => changeModelSource("builtin")}>内置模型</button>
              <button type="button" className={draft.modelSource === "custom" ? "active" : ""} aria-pressed={draft.modelSource === "custom"} onClick={() => changeModelSource("custom")}>自定义服务</button>
            </div>

            {draft.modelSource === "builtin" ? (
              <div className="field-group">
                <label htmlFor="builtin-provider">内置服务商</label>
                <RoundedSelect
                  id="builtin-provider"
                  ariaLabel="内置服务商"
                  value={draft.provider}
                  options={[{ value: "", label: "选择服务商" }, ...providerOptions.map(([value, label]) => ({ value, label }))]}
                  onChange={(value) => { updateModelIdentity("provider", value); updateModelIdentity("model", ""); setFilterModels(false); setModelListOpen(false); }}
                />
              </div>
            ) : (
              <>
                <TextField label="服务商" value={draft.provider} onChange={(value) => updateModelIdentity("provider", value)} placeholder="例如 openai" />
                <TextField label="Base URL" value={draft.baseUrl} onChange={(value) => { updateModelIdentity("baseUrl", value); setDiscoveredModels([]); setModelListOpen(false); }} placeholder="https://api.example.com/v1" />
              </>
            )}

            {draft.modelSource === "custom" && draft.baseUrl ? (
              <div className="two-fields">
                <div className="field-group"><label htmlFor="main-protocol">接口协议</label><RoundedSelect id="main-protocol" ariaLabel="接口协议" value={draft.protocol} options={PROTOCOL_OPTIONS} onChange={(value) => { updateModelIdentity("protocol", value as AppSettings["protocol"]); setDiscoveredModels([]); setModelListOpen(false); }} /></div>
                <ModelCapabilityStatus status={modelCapability} />
              </div>
            ) : null}

            <div className="field-group"><label htmlFor="main-key">API Key</label><div className="secret-field"><input id="main-key" type={showKey ? "text" : "password"} value={draft.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={draft.mainKeyStored ? "已安全保存在当前项目，留空继续使用" : "输入主模型密钥"} /><button className="icon-button" type="button" onClick={() => setShowKey((value) => !value)} aria-label="显示或隐藏密钥">{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></div>
            <label className="check-row"><input type="checkbox" checked={draft.rememberApiKey} onChange={(event) => update("rememberApiKey", event.target.checked)} /><span>在这台电脑上记住主模型密钥</span></label>
            <div className="field-group model-combobox" ref={modelComboRef}>
              <div className="field-label-row">
                <label htmlFor="model-name">模型名称</label>
                {draft.modelSource === "custom" ? <button className="inline-discovery-button" type="button" disabled={testing !== null || discovering} onClick={() => void runDiscovery()}>{discovering ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}{discovering ? "正在获取…" : "获取模型"}</button> : null}
              </div>
              <div className="combobox-control">
                <input
                  id="model-name"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={modelListOpen}
                  aria-controls="model-options"
                  value={draft.model}
                  onFocus={() => selectableModels.length > 0 && setModelListOpen(true)}
                  onChange={(event) => { updateModelIdentity("model", event.target.value); setFilterModels(true); setActiveModelIndex(0); setModelListOpen(true); }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") { event.preventDefault(); setModelListOpen(true); setActiveModelIndex((value) => Math.min(value + 1, Math.max(visibleModels.length - 1, 0))); }
                    if (event.key === "ArrowUp") { event.preventDefault(); setActiveModelIndex((value) => Math.max(value - 1, 0)); }
                    if (event.key === "Escape") setModelListOpen(false);
                    if (event.key === "Enter" && modelListOpen && visibleModels[activeModelIndex]) {
                      event.preventDefault();
                      updateModelIdentity("model", visibleModels[activeModelIndex].id);
                      setModelListOpen(false);
                    }
                  }}
                  placeholder={draft.modelSource === "builtin" ? "搜索内置模型" : "可以手动填写或获取后搜索"}
                  autoComplete="off"
                />
                <button className="combobox-toggle" type="button" aria-label="展开模型列表" onClick={() => { setFilterModels(false); setActiveModelIndex(0); setModelListOpen((value) => !value); }}><ChevronDown size={16} /></button>
              </div>
              {modelListOpen ? (
                <div className="model-options" id="model-options" role="listbox">
                  {visibleModels.length ? visibleModels.map((item, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={item.id === draft.model}
                      className={index === activeModelIndex ? "active" : ""}
                      key={item.id}
                      onMouseEnter={() => setActiveModelIndex(index)}
                      onClick={() => { updateModelIdentity("model", item.id); setModelListOpen(false); }}
                    ><strong>{item.id}</strong>{item.name !== item.id ? <small>{item.name}</small> : null}</button>
                  )) : <p>{draft.modelSource === "builtin" ? "没有匹配的内置模型" : "没有匹配模型，可继续手动填写"}</p>}
                </div>
              ) : null}
              <span className="settings-help">{draft.modelSource === "builtin" ? "从项目内 Pi 模型目录中选择。" : "点击“获取模型”时，密钥只用于读取当前服务的模型列表。"}</span>
            </div>
            <div className="field-group thinking-level-field">
              <label htmlFor="thinking-level">思考强度</label>
              <RoundedSelect
                id="thinking-level"
                ariaLabel="思考强度"
                value={draft.thinkingLevel}
                options={thinkingOptions}
                onChange={(value) => changeThinkingLevel(value as ThinkingLevelSetting)}
              />
              <span className="settings-help">{displayedThinkingCapability
                ? displayedThinkingCapability.message
                : "测试模型后获取可用档位"}。强度越高通常耗时越长、Token 消耗越多。</span>
              {manualThinkingEditable ? (
                <div className="manual-thinking">
                  <RoundedMultiSelect
                    id="manual-thinking-levels"
                    ariaLabel="手动设置可用档位"
                    values={manualThinkingLevels}
                    options={THINKING_LEVEL_OPTIONS}
                    placeholder="手动设置可用档位"
                    confirmLabel="确认可用档位"
                    saving={savingThinking}
                    disabled={!capabilityForSettings(draft)?.capabilityId || savingThinking}
                    onConfirm={(levels) => void saveManualThinking(levels)}
                  />
                </div>
              ) : null}
            </div>
            {(draft.modelSource === "builtin" || !draft.baseUrl) ? <ModelCapabilityStatus status={modelCapability} /> : null}
            <button className="secondary-button test-button" type="button" disabled={testing !== null} onClick={() => void runTest()}>{testing === "model" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}测试连接、图片与思考能力</button>
            {draft.modelSource === "custom" ? <p className="settings-help model-probe-note">模型连接测试会发送少量请求，并产生少量 Token。</p> : null}
            {testResult?.kind === "model" ? <p className="test-success">{testResult.text}{testResult.detail ? <small>{testResult.detail}</small> : null}</p> : null}
          </section>

        </div>

        <footer className="drawer-footer"><button className="quiet-button" type="button" onClick={props.onClose}>取消</button><button className="primary-button" type="button" onClick={() => void props.onSave(draftRef.current)}>保存设置</button></footer>
      </aside>
    </div>
  );
}

function TextField(props: { label: string; value: string; placeholder: string; type?: string; onChange(value: string): void }) {
  return <div className="field-group"><label>{props.label}</label><input type={props.type ?? "text"} value={props.value} placeholder={props.placeholder} onChange={(event) => props.onChange(event.target.value)} /></div>;
}

function ModelCapabilityStatus(props: { status: VisionProbeStatus | "untested" }) {
  const copy = props.status === "supported"
    ? { title: "已确认支持图片", detail: "任务会直接使用主模型理解画面", tone: "supported" }
    : props.status === "unsupported"
      ? { title: "已确认仅支持文本", detail: "该模型不能用于视频任务", tone: "unsupported" }
      : props.status === "inconclusive"
        ? { title: "图片能力无法确认", detail: "需要重新测试后才能开始任务", tone: "inconclusive" }
        : { title: "尚未检测图片能力", detail: "测试后才能开始或继续任务", tone: "untested" };
  const Icon = props.status === "supported" ? CheckCircle2 : AlertCircle;
  return <div className={`model-capability-status ${copy.tone}`} role="status"><Icon size={17} /><span><strong>{copy.title}</strong><small>{copy.detail}</small></span></div>;
}
