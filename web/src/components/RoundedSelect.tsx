import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface RoundedSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface RoundedSelectProps {
  id: string;
  ariaLabel: string;
  value: string;
  options: RoundedSelectOption[];
  onChange(value: string): void;
  disabled?: boolean;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function RoundedSelect({ id, ariaLabel, value, options, onChange, disabled = false }: RoundedSelectProps) {
  const generatedId = useId().replaceAll(":", "");
  const listboxId = `${id}-${generatedId}-options`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => selectedIndex(options, value));
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0, width: 0, maxHeight: 280 });
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) return;
    setActiveIndex(selectedIndex(options, value));
  }, [open, options, value]);

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
      const desired = Math.min(menu.scrollHeight || 280, 280);
      const openAbove = below < Math.min(desired, 160) && above > below;
      const maxHeight = Math.max(96, Math.min(280, openAbove ? above : below));
      const menuHeight = Math.min(desired, maxHeight);
      const width = Math.max(rect.width, 180);
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
    const frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const move = (direction: 1 | -1) => {
    if (options.length === 0) return;
    let index = activeIndex;
    for (let count = 0; count < options.length; count += 1) {
      index = (index + direction + options.length) % options.length;
      if (!options[index]?.disabled) {
        setActiveIndex(index);
        return;
      }
    }
  };

  const jump = (edge: "start" | "end") => {
    const indices = edge === "start" ? options.keys() : [...options.keys()].reverse();
    for (const index of indices) {
      if (!options[index]?.disabled) {
        setActiveIndex(index);
        return;
      }
    }
  };

  return (
    <div className="rounded-select">
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
        aria-activedescendant={open && options[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            setOpen(true);
            jump(event.key === "Home" ? "start" : "end");
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) choose(activeIndex);
            else setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        <span>{selected?.label ?? "请选择"}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          className="rounded-select-popover"
          style={{ top: position.top, left: position.left, width: position.width }}
        >
          <div id={listboxId} role="listbox" aria-label={ariaLabel} style={{ maxHeight: position.maxHeight }}>
            {options.map((option, index) => (
              <button
                id={`${listboxId}-${index}`}
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={index === activeIndex ? "active" : ""}
                disabled={option.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function selectedIndex(options: RoundedSelectOption[], value: string): number {
  const selected = options.findIndex((option) => option.value === value && !option.disabled);
  if (selected >= 0) return selected;
  const available = options.findIndex((option) => !option.disabled);
  return Math.max(available, 0);
}
