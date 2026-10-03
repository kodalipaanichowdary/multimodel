import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AgentDefinitionSchema, PermissionSchema, type Permission } from "@pos/schemas";
import { ApiError, createAgent, fetchAgents, type FieldErrors } from "../lib/api";
import { DANGEROUS } from "../lib/theme";
import { useGraph } from "../store/graph";

const PERMISSIONS = PermissionSchema.options;
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Map schema paths (zod or FastAPI loc) onto form fields. */
const fieldOf = (path: string) => (path.startsWith("model_profile") ? "model" : path.split(".")[0] ?? "");

export function AddAgentDialog() {
  const open = useGraph((s) => s.addAgentOpen);
  const setOpen = useGraph((s) => s.setAddAgentOpen);
  const [f, setF] = useState({ id: "", name: "", description: "", capabilities: "", tools: "", model: "llama3.2:3b" });
  const [perms, setPerms] = useState<Permission[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const dangerous = perms.filter((p) => DANGEROUS.has(p));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const candidate = {
      id: f.id.trim(),
      name: f.name.trim(),
      description: f.description.trim(),
      capabilities: list(f.capabilities),
      tools: list(f.tools),
      memory: { scope: "task", kind: "none" },
      model_profile: { provider: "ollama", model: f.model.trim(), temperature: 0, max_tokens: 1024 },
      permissions: perms,
    };
    const parsed = AgentDefinitionSchema.safeParse(candidate);
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const i of parsed.error.issues) (errs[fieldOf(i.path.join("."))] ??= []).push(i.message);
      setErrors(errs);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await createAgent(parsed.data);
      useGraph.getState().setAgents(await fetchAgents());
      setOpen(false);
      setF({ id: "", name: "", description: "", capabilities: "", tools: "", model: "llama3.2:3b" });
      setPerms([]);
    } catch (err) {
      if (err instanceof ApiError) {
        const errs: FieldErrors = {};
        for (const [k, v] of Object.entries(err.fields)) (errs[k ? fieldOf(k) : ""] ??= []).push(...v);
        setErrors(errs);
      } else {
        setErrors({ "": [String(err)] });
      }
    } finally {
      setBusy(false);
    }
  }

  const input = (key: keyof typeof f, label: string, hint?: string, area = false) => (
    <Field label={label} hint={hint} error={errors[key]} name={key}>
      {area ? (
        <textarea
          data-testid={`agent-${key}`}
          value={f[key]}
          onChange={(e) => setF({ ...f, [key]: e.target.value })}
          rows={2}
          className={INPUT}
        />
      ) : (
        <input
          data-testid={`agent-${key}`}
          value={f[key]}
          onChange={(e) => setF({ ...f, [key]: e.target.value })}
          className={INPUT}
        />
      )}
    </Field>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3" onClick={() => setOpen(false)}>
      <form
        data-testid="add-agent-form"
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        noValidate
        className="max-h-[92dvh] w-[min(480px,100%)] overflow-y-auto overflow-x-hidden rounded-xl border border-white/10 bg-[#0d0f16] p-4 text-sm shadow-2xl"
      >
        <h2 className="mb-3 text-base font-semibold text-slate-100">Add agent</h2>
        {errors[""] && (
          <p data-testid="agent-error" className="mb-3 break-words rounded bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
            {errors[""].join("; ")}
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {input("id", "id", "lowercase, e.g. critic")}
          {input("name", "name")}
        </div>
        {input("description", "description", undefined, true)}
        {input("capabilities", "capabilities", "comma-separated")}
        {input("tools", "tools", "comma-separated, optional")}
        {input("model", "model", "Ollama model tag")}
        <Field label="permissions" error={errors.permissions} name="permissions">
          <div className="flex flex-wrap gap-1.5">
            {PERMISSIONS.map((p) => {
              const on = perms.includes(p);
              const danger = DANGEROUS.has(p);
              return (
                <label
                  key={p}
                  className={`flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs ${
                    on ? (danger ? "border-red-400/60 bg-red-500/15 text-red-200" : "border-violet-400/50 bg-violet-500/15 text-violet-100") : "border-white/10 text-slate-400"
                  }`}
                >
                  <input
                    type="checkbox"
                    data-testid={`perm-${p}`}
                    checked={on}
                    onChange={() => setPerms(on ? perms.filter((x) => x !== p) : [...perms, p])}
                    className="accent-violet-500"
                  />
                  {p}
                  {danger && <span title="requires approval">⚠</span>}
                </label>
              );
            })}
          </div>
        </Field>
        {dangerous.length > 0 && (
          <p data-testid="danger-warning" className="mb-3 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
            ⚠ {dangerous.join(", ")}: tools using these require human approval on every call.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-slate-400 hover:bg-white/5">
            Cancel
          </button>
          <button
            type="submit"
            data-testid="agent-submit"
            disabled={busy}
            className="rounded-lg bg-violet-500 px-4 py-1.5 font-medium text-white hover:bg-violet-400 disabled:opacity-40"
          >
            {busy ? "Adding…" : "Add agent"}
          </button>
        </div>
      </form>
    </div>
  );
}

const INPUT =
  "w-full min-w-0 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-slate-100 focus:border-violet-400/60";

function Field(props: { label: string; hint?: string; error?: string[]; name: string; children: ReactNode }) {
  return (
    <div className="mb-3 min-w-0">
      <div className="mb-1 flex items-baseline gap-2 text-xs">
        <span className="text-slate-300">{props.label}</span>
        {props.hint && <span className="text-slate-600">{props.hint}</span>}
      </div>
      {props.children}
      {props.error && (
        <p data-testid={`err-${props.name}`} className="mt-1 break-words text-xs text-red-400">
          {props.error.join("; ")}
        </p>
      )}
    </div>
  );
}
