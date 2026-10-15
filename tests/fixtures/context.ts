import type { NativeForm } from "#agent/context/nativeForm.js";

export const tool = (name: string, properties = {}) => ({
  name,
  inputSchema: { type: "object" as const, properties },
});

export const capabilities = [
  tool("browser_evaluate"),
  tool("browser_snapshot", { target: { type: "string" } }),
];

export const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

export const page = (tree: string) =>
  textResult(
    `### Page\n- Page URL: http://fixture/?runId=exact\n### Snapshot\n\`\`\`yaml\n${tree}\n\`\`\``,
  );

export const compactTree =
  '- generic [ref=e1]:\n  - textbox "Name" [ref=e2]\n  - button "Send message" [ref=e3]';

export const full = page(
  compactTree +
    "\n- complementary [ref=e4]:\n" +
    "  - paragraph: Useful guide information about contact details.\n".repeat(
      300,
    ),
);

export const native: NativeForm = {
  url: "http://fixture/?runId=exact",
  target: "#contact",
  fingerprint: "stable",
  fields: [
    {
      id: "name",
      role: "textbox",
      htmlType: "text",
      label: "Name",
      required: true,
      disabled: false,
      readonly: false,
      value: "",
      constraints: { minlength: "2" },
    },
  ],
  outside: ["Contact us", "Use your legal name."],
  feedback: ["Request DEMO-123 received"],
};
