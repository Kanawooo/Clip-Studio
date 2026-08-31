import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RoundedSelectOption } from "./RoundedSelect.tsx";

interface RoundedMultiSelectProps {
  id: string;
  ariaLabel: string;
  values: string[];
  options: RoundedSelectOption[];
  placeholder: string;
  confirmLabel?: string;
  saving?: boolean;
  disabled?: boolean;
  onConfirm(values: string[]): void;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function RoundedMultiSelect({
  id,
  ariaLabel,
  values,
  options,
  placeholder,
  confirmLabel = "确认",
  saving = false,
  disabled = false,
  onConfirm,
}: RoundedMultiSelectProps) {
  const generatedId = useId().replaceAll(":", "");
  const listboxId = `${id}-${generatedId}-options`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [pendingValues, setPendingValues] = useState<string[]>(values);
  const [activeIndex, setActiveIndex] = useState(() => firstAvailableIndex(options));
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0, width: 0, maxHeight: 320 });

  const selectedLabels = options
    .filter((option) => values.includes(option.value))
    .map((option) => option.label);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) return;
    setPendingValues(values);
    setActiveIndex(firstAvailableIndex(options));
  }, [open, options, values]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const viewportGap = 8;
      const controlGap = 6;
      const below = window.innerHeight - rect.bottom - viewportGap - controlGap;
      const above = rect.top - viewportGap - controlGap;
      const desired = Math.min(menu.scrollHeight || 320, 320);
      const openAbove = below < Math.min(desired, 180) && above > below;
      const maxHeight = Math.max(140, Math.min(320, openAbove ? above : below));
      const menuHeight = Math.min(desired, maxHeight);
      const width = Math.max(rect.width, 220);
      const left = Math.min(
        Math.max(viewportGap, rect.left),
        Math.max(viewportGap, window.innerWidth - width - viewportGap),
      );
      setPosition({
        top: openAbove ? Math.max(viewportGap, rect.top - controlGap - menuHeight) : rect.bottom + controlGap,
        left,
        width,
        maxHeight,
      });
    };
    update();
    const frame = window.requestAnimationFrame(() => {
      update();
      optionRefs.current[activeIndex]?.focus();
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [activeIndex, open, options.length]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setPendingValues(values);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = () => {
    setPendingValues(values);
    setActiveIndex(firstAvailableIndex(options));
    setOpen(true);
  };

  const toggle = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setPendingValues((current) => current.includes(option.value)
      ? current.filter((value) => value !== option.value)
      : options.filter((item) => item.value === option.value || current.includes(item.value)).map((item) => item.value));
  };

  const move = (direction: 1 | -1) => {
    if (options.length === 0) return;
    let index = activeIndex;
    for (let count = 0; count < options.length; count += 1) {
      index = (index + direction + options.length) % options.length;
      if (!options[index]?.disabled) {
        setActiveIndex(index);
        optionRefs.current[index]?.focus();
        return;
      }
    }
  };

  const jump = (edge: "start" | "end") => {
    const indices = edge === "start" ? [...options.keys()] : [...options.keys()].reverse();
    const index = indices.find((candidate) => !options[candidate]?.disabled);
    if (index === undefined) return;
    setActiveIndex(index);
    optionRefs.current[index]?.focus();
  };

  const handleOptionKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      jump(event.key === "Home" ? "start" : "end");
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle(index);
    }
  };

  return (
    <div className="rounded-multi-select">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        className="rounded-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => open ? close(false) : openMenu()}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") && !open) {
            event.preventDefault();
            openMenu();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close(false);
          }
        }}
      >
        <span>{selectedLabels.length > 0 ? selectedLabels.join("、") : placeholder}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          className="rounded-select-popover rounded-multi-select-popover"
          style={{ top: position.top, left: position.left, width: position.width }}
        >
          <div
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            aria-multiselectable="true"
            style={{ maxHeight: Math.max(90, position.maxHeight - 54) }}
          >
            {options.map((option, index) => {
              const checked = pendingValues.includes(option.value);
              return (
                <button
                  ref={(element) => { optionRefs.current[index] = element; }}
                  id={`${listboxId}-${index}`}
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  className={index === activeIndex ? "active" : ""}
                  disabled={option.disabled}
                  onFocus={() => setActiveIndex(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => toggle(index)}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                >
                  <span className={`multi-select-check${checked ? " checked" : ""}`} aria-hidden="true">
                    {checked ? <Check size={12} /> : null}
                  </span>
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
          <div className="rounded-multi-select-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={saving || pendingValues.length === 0}
              onClick={() => {
                onConfirm(pendingValues);
                close(true);
              }}
            >{saving ? "正在保存…" : confirmLabel}</button>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function firstAvailableIndex(options: RoundedSelectOption[]): number {
  const index = options.findIndex((option) => !option.disabled);
  return Math.max(index, 0);
}
