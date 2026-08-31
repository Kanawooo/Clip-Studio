import { FileVideo2, FolderOpen, X } from "lucide-react";

interface PathPickerFieldProps {
  id: string;
  label: string;
  value: string;
  kind: "file" | "directory";
  placeholder: string;
  disabled?: boolean;
  pickDisabled?: boolean;
  picking?: boolean;
  onChange(value: string): void;
  onPick(): void;
}

export function PathPickerField(props: PathPickerFieldProps) {
  const Icon = props.kind === "file" ? FileVideo2 : FolderOpen;
  return (
    <div className="field-group">
      <label htmlFor={props.id}>{props.label}</label>
      <div className="path-field">
        <Icon size={17} aria-hidden="true" />
        <input
          id={props.id}
          className="path-input"
          value={props.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
        {props.value && !props.disabled ? (
          <button className="icon-button" type="button" onClick={() => props.onChange("")} aria-label={`清除${props.label}`}>
            <X size={15} />
          </button>
        ) : null}
        <button className="pick-button" type="button" disabled={props.disabled || props.pickDisabled} onClick={props.onPick}>
          {props.picking ? "选择中…" : "选择"}
        </button>
      </div>
    </div>
  );
}
