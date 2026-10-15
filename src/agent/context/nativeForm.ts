import { z } from "zod";

/** HTML constraints remain strings, including dates; no values are coerced. */
export type NativeField = z.infer<typeof nativeFieldSchema>;

export type NativeForm = z.infer<typeof nativeFormSchema>;

const nativeOptionSchema = z.looseObject({
  label: z.string(),
  value: z.string(),
  disabled: z.boolean(),
});

const nativeFieldSchema = z.looseObject({
  id: z.string(),
  role: z.string(),
  htmlType: z.string(),
  label: z.string(),
  required: z.boolean(),
  disabled: z.boolean(),
  readonly: z.boolean(),
  value: z.union([z.string(), z.boolean()]),
  constraints: z.record(z.string(), z.string()),
  options: z.array(nativeOptionSchema).optional(),
  group: z.string().optional(),
  help: z.string().optional(),
  validationMessage: z.string().optional(),
  ref: z.string().optional(),
});

export const nativeFormSchema = z
  .looseObject({
    url: z.string(),
    target: z.string(),
    fingerprint: z.string(),
    fields: z.array(nativeFieldSchema),
    outside: z.array(z.string()),
    feedback: z.array(z.string()),
  })
  .refine((value) => !value.fallback);

// Reads one visible native form's fields, constraints, and page feedback;
// returns a fallback reason when the page cannot be safely summarized.
// Raw JavaScript keeps transpilation helpers out of browser execution.
export const nativeFormScript = String.raw`(() => {
  const isVisible = (element) =>
    element.checkVisibility({ checkVisibilityCSS: true }) &&
    !element.closest('[hidden],[aria-hidden="true"]');

  const getText = (element) =>
    (element?.textContent || "").replace(/\s+/g, " ").trim();

  const getLabel = (element) => {
    const ids = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean);
    if (ids.some((id) => !document.getElementById(id))) return null;
    if (ids.length) {
      return ids.map((id) => getText(document.getElementById(id))).join(" ");
    }
    return (
      element.getAttribute("aria-label") ||
      Array.from(element.labels || [])
        .map(getText)
        .join(" ")
    );
  };

  const getRole = (element) => {
    if (element.type === "file") return "button";
    if (element.tagName === "SELECT") return "combobox";
    if (element.type === "number") return "spinbutton";
    if (element.type === "range") return "slider";
    if (["radio", "checkbox"].includes(element.type)) return element.type;
    return "textbox";
  };

  const getConstraints = (element) => {
    const constraints = {};
    for (const key of [
      "min",
      "max",
      "step",
      "pattern",
      "minlength",
      "maxlength",
      "accept",
    ]) {
      if (element.hasAttribute(key))
        constraints[key] = element.getAttribute(key);
    }
    return constraints;
  };

  const extractField = (element, label) => {
    const field = {
      id: element.id || element.name || "",
      role: getRole(element),
      htmlType: element.tagName === "TEXTAREA" ? "textarea" : element.type,
      label,
      required: element.required,
      disabled: element.matches(":disabled"),
      readonly: !!element.readOnly,
      value: ["radio", "checkbox"].includes(element.type)
        ? element.checked
        : element.value,
      constraints: getConstraints(element),
    };
    const group = getText(element.closest("fieldset")?.querySelector("legend"));
    if (group) field.group = group;
    const describedIds = (element.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter(Boolean);
    const help = describedIds
      .map((id) => getText(document.getElementById(id)))
      .join(" ");
    if (help) field.help = help;
    if (element.validationMessage)
      field.validationMessage = element.validationMessage;
    if (element.tagName === "SELECT") {
      field.options = Array.from(element.options).map((option) => ({
        label: option.label,
        value: option.value,
        disabled: option.disabled || !!option.closest("optgroup[disabled]"),
      }));
    }
    return field;
  };

  const forms = Array.from(document.forms).filter(isVisible);
  if (document.querySelector("iframe,frame")) return { fallback: "frames" };
  if (forms.length !== 1)
    return { fallback: "expected one visible native form" };
  const form = forms[0];
  const widgets = [
    '[contenteditable]:not([contenteditable="false"])',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="listbox"]',
    '[role="switch"]',
    '[role="button"]',
  ].join(",");
  if (
    Array.from(document.querySelectorAll(widgets)).some(
      (element) =>
        isVisible(element) && !element.matches("input,select,textarea,button"),
    )
  )
    return { fallback: "custom widget" };
  if (
    Array.from(
      document.querySelectorAll("input,select,textarea,button,a[href]"),
    ).some(
      (element) =>
        isVisible(element) &&
        !form.contains(element) &&
        !element.closest("aside,nav,footer"),
    )
  )
    return { fallback: "interactive control outside form" };

  const target = form.id ? "#" + CSS.escape(form.id) : "form";
  if (document.querySelectorAll(target).length !== 1)
    return { fallback: "ambiguous form target" };
  const fields = [];
  for (const element of Array.from(form.elements)) {
    if (
      !element.matches("input,select,textarea") ||
      element.type === "hidden" ||
      !isVisible(element)
    )
      continue;
    if (["submit", "reset", "button", "image"].includes(element.type)) continue;
    if (element.multiple || element.getAttribute("role"))
      return { fallback: "unsupported native control" };
    const label = getLabel(element);
    if (label === null) return { fallback: "missing accessible label" };
    if (!label) return { fallback: "unlabelled control" };
    fields.push(extractField(element, label));
  }
  if (!fields.length) return { fallback: "no native fields" };

  const outside = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (
      !parent ||
      form.contains(parent) ||
      parent.closest("aside article,nav,footer,script,style,noscript") ||
      !isVisible(parent)
    )
      continue;
    const value = walker.currentNode.textContent.replace(/\s+/g, " ").trim();
    if (value) outside.push(value);
  }
  const feedback = Array.from(
    document.querySelectorAll('[role="status"],[role="alert"],output'),
  )
    .filter(isVisible)
    .map(getText)
    .filter(Boolean);
  const data = { url: location.href, target, fields, outside, feedback };
  const source = JSON.stringify(data) + document.body.innerText;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  }
  return {
    ...data,
    fingerprint: source.length + ":" + (hash >>> 0).toString(16),
  };
})`;
