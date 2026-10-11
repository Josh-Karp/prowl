/** A read-only native-form observation. HTML constraints remain strings (dates included). */
export interface NativeField {
  id: string;
  role: string;
  htmlType: string;
  label: string;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  value: string | boolean;
  constraints: Record<string, string>;
  options?: Array<{ label: string; value: string; disabled: boolean }>;
  group?: string;
  help?: string;
  validationMessage?: string;
  ref?: string;
}
export interface NativeForm {
  url: string;
  target: string;
  fingerprint: string;
  fields: NativeField[];
  outside: string[];
  feedback: string[];
}
export interface BrowserResult {
  content?: unknown;
  isError?: unknown;
  [key: string]: unknown;
}
export interface BrowserClient {
  callTool(call: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<BrowserResult>;
}
interface Capability {
  name: string;
  inputSchema?: unknown;
}
export interface ContextEvent {
  kind: "observation";
  originalBytes: number;
  returnedBytes: number;
  reduced: boolean;
  reason: string;
}

// Kept as JavaScript source so transpilation cannot introduce helpers into browser execution.
export const nativeFormScript = String.raw`(() => {
  const visible = el => el.checkVisibility({ checkVisibilityCSS: true }) && !el.closest('[hidden],[aria-hidden="true"]');
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const forms = Array.from(document.forms).filter(visible);
  if (document.querySelector('iframe,frame')) return { fallback: 'frames' };
  if (forms.length !== 1) return { fallback: 'expected one visible native form' };
  const form = forms[0];
  const widgets = '[contenteditable]:not([contenteditable="false"]),[role="combobox"],[role="textbox"],[role="checkbox"],[role="radio"],[role="slider"],[role="spinbutton"],[role="listbox"],[role="switch"],[role="button"]';
  if (Array.from(document.querySelectorAll(widgets)).some(el => visible(el) && !el.matches('input,select,textarea,button'))) return { fallback: 'custom widget' };
  if (Array.from(document.querySelectorAll('input,select,textarea,button,a[href]')).some(el => visible(el) && !form.contains(el) && !el.closest('aside,nav,footer'))) return { fallback: 'interactive control outside form' };
  let target = form.id ? '#' + CSS.escape(form.id) : 'form';
  if (document.querySelectorAll(target).length !== 1) return { fallback: 'ambiguous form target' };
  const fields = [];
  for (const el of Array.from(form.elements)) {
    if (!el.matches('input,select,textarea') || el.type === 'hidden' || !visible(el)) continue;
    if (['submit','reset','button','image'].includes(el.type)) continue;
    if (el.multiple || el.getAttribute('role')) return { fallback: 'unsupported native control' };
    const labelIds = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (labelIds.some(id => !document.getElementById(id))) return { fallback: 'missing accessible label' };
    const label = labelIds.length ? labelIds.map(id => text(document.getElementById(id))).join(' ') : el.getAttribute('aria-label') || Array.from(el.labels || []).map(text).join(' ');
    if (!label) return { fallback: 'unlabelled control' };
    const role = el.type === 'file' ? 'button' : el.tagName === 'SELECT' ? 'combobox' : el.type === 'number' ? 'spinbutton' : el.type === 'range' ? 'slider' : ['radio','checkbox'].includes(el.type) ? el.type : 'textbox';
    const constraints = {};
    for (const key of ['min','max','step','pattern','minlength','maxlength','accept']) if (el.hasAttribute(key)) constraints[key] = el.getAttribute(key);
    const describedIds = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const field = { id: el.id || el.name || '', role, htmlType: el.tagName === 'TEXTAREA' ? 'textarea' : el.type, label, required: el.required, disabled: el.matches(':disabled'), readonly: !!el.readOnly, value: ['radio','checkbox'].includes(el.type) ? el.checked : el.value, constraints };
    const group = text(el.closest('fieldset')?.querySelector('legend'));
    if (group) field.group = group;
    const help = describedIds.map(id => text(document.getElementById(id))).join(' ');
    if (help) field.help = help;
    if (el.validationMessage) field.validationMessage = el.validationMessage;
    if (el.tagName === 'SELECT') field.options = Array.from(el.options).map(o => ({ label: o.label, value: o.value, disabled: o.disabled || !!o.closest('optgroup[disabled]') }));
    fields.push(field);
  }
  if (!fields.length) return { fallback: 'no native fields' };
  const outside = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (!parent || form.contains(parent) || parent.closest('aside article,nav,footer,script,style,noscript') || !visible(parent)) continue;
    const value = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
    if (value) outside.push(value);
  }
  const feedback = Array.from(document.querySelectorAll('[role="status"],[role="alert"],output')).filter(visible).map(text).filter(Boolean);
  const data = { url: location.href, target, fields, outside, feedback };
  const source = JSON.stringify(data) + document.body.innerText;
  let hash = 2166136261;
  for (let i=0; i<source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return { ...data, fingerprint: source.length + ':' + (hash >>> 0).toString(16) };
})`;

function texts(result: BrowserResult): string[] | null {
  if (!Array.isArray(result.content) || !result.content.length) return null;
  const values: string[] = [];
  for (const item of result.content) {
    if (
      !item ||
      typeof item !== "object" ||
      item.type !== "text" ||
      typeof item.text !== "string"
    )
      return null;
    values.push(item.text);
  }
  return values;
}
function snapshot(result: BrowserResult): string | null {
  const all = texts(result);
  if (!all || result.isError) return null;
  const found = all.flatMap((value) => [
    ...value.matchAll(/### Snapshot\s*\n```ya?ml\n([\s\S]*?)\n```/g),
  ]);
  return found.length === 1 ? found[0][1] : null;
}
function nativeResult(result: BrowserResult): NativeForm | null {
  if (result.isError) return null;
  const match = texts(result)
    ?.join("\n")
    .match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  if (!match) return null;
  const value = JSON.parse(match[1]);
  if (
    value?.fallback ||
    typeof value?.url !== "string" ||
    typeof value?.target !== "string" ||
    typeof value?.fingerprint !== "string" ||
    !Array.isArray(value.fields) ||
    !Array.isArray(value.outside) ||
    !Array.isArray(value.feedback)
  )
    return null;
  return value as NativeForm;
}
export function attachFieldRefs(
  fields: NativeField[],
  tree: string,
): NativeField[] | null {
  const refs: Array<{ role: string; label: string; ref: string }> = [];
  for (const line of tree.split("\n")) {
    const match = line.match(
      /^\s*- ([\w-]+) ("(?:[^"\\]|\\.)*")(?=\s|:|$).*?\[ref=([^\]]+)\]/,
    );
    if (!match) continue;
    try {
      refs.push({ role: match[1], label: JSON.parse(match[2]), ref: match[3] });
    } catch {
      return null;
    }
  }
  const mapped: NativeField[] = [];
  for (const field of fields) {
    const matches = refs.filter(
      (ref) => ref.role === field.role && ref.label === field.label,
    );
    if (
      matches.length !== 1 ||
      mapped.some((previous) => previous.ref === matches[0].ref)
    )
      return null;
    mapped.push({ ...field, ref: matches[0].ref });
  }
  return mapped;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export class BrowserContext {
  private supported: boolean;
  constructor(
    private client: BrowserClient,
    capabilities: Capability[],
    private event: (event: ContextEvent) => void = () => {},
    private archive: (value: BrowserResult) => void = () => {},
  ) {
    const schema = capabilities.find((tool) => tool.name === "browser_snapshot")
      ?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    this.supported =
      capabilities.some((tool) => tool.name === "browser_evaluate") &&
      !!schema?.properties?.target;
  }
  async fullSnapshot(): Promise<BrowserResult> {
    const result = await this.client.callTool({
      name: "browser_snapshot",
      arguments: {},
    });
    this.archive(result);
    return result;
  }
  async reduce(
    name: string,
    args: Record<string, unknown>,
    original: BrowserResult,
  ): Promise<BrowserResult> {
    if (
      !snapshot(original) ||
      bytes(original) < 8192 ||
      (name === "browser_snapshot" &&
        ["target", "depth", "boxes", "filename"].some((key) =>
          Object.hasOwn(args, key),
        ))
    )
      return original;
    const record = (
      result: BrowserResult,
      reduced: boolean,
      reason: string,
    ) => {
      this.event({
        kind: "observation",
        originalBytes: bytes(original),
        returnedBytes: bytes(result),
        reduced,
        reason,
      });
      return result;
    };
    if (!this.supported)
      return record(original, false, "unsupported MCP capabilities");
    this.archive(original);
    let reason = "form extraction failed";
    try {
      const before = nativeResult(
        await this.client.callTool({
          name: "browser_evaluate",
          arguments: { function: nativeFormScript },
        }),
      );
      if (before) {
        const scoped = await this.client.callTool({
          name: "browser_snapshot",
          arguments: { target: before.target },
        });
        const tree = snapshot(scoped);
        const after = nativeResult(
          await this.client.callTool({
            name: "browser_evaluate",
            arguments: { function: nativeFormScript },
          }),
        );
        const fields = tree ? attachFieldRefs(before.fields, tree) : null;
        if (!after || JSON.stringify(after) !== JSON.stringify(before))
          reason = "page changed during extraction";
        else if (!fields) reason = "ambiguous native control refs";
        else {
          const metadata = {
            url: before.url,
            outside: before.outside,
            feedback: before.feedback,
          };
          const replacement =
            "### Snapshot\n```yaml\n" +
            tree +
            "\n```\n### Native form metadata\n" +
            JSON.stringify({ ...metadata, fields });
          const result: BrowserResult = {
            ...original,
            content: (
              original.content as Array<{ type: "text"; text: string }>
            ).map((item) => ({
              ...item,
              text: item.text.replace(
                /### Snapshot\s*\n```ya?ml\n[\s\S]*?\n```/,
                () => replacement,
              ),
            })),
          };
          const saved = bytes(original) - bytes(result);
          if (saved >= 2048 && saved >= bytes(original) * 0.25)
            return record(result, true, "scoped native form");
          reason = "insufficient savings";
        }
      } else reason = "unsupported or ambiguous native form";
    } catch {
      /* A fresh full snapshot restores current refs after any helper failure. */
    }
    // Propagate a failed refresh rather than returning potentially stale original refs.
    return record(await this.fullSnapshot(), false, reason);
  }
}
