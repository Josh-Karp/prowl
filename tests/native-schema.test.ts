import assert from "node:assert/strict";
import test from "node:test";
import { nativeFormSchema } from "#agent/context/nativeForm.js";
import { native } from "#tests/fixtures/context.js";

test("native schema rejects malformed metadata without coercing constraints or booleans", () => {
  for (const key of Object.keys(native)) {
    assert.equal(
      nativeFormSchema.safeParse({ ...native, [key]: undefined }).success,
      false,
      key,
    );
  }
  for (const key of Object.keys(native.fields[0])) {
    assert.equal(
      nativeFormSchema.safeParse({
        ...native,
        fields: [{ ...native.fields[0], [key]: undefined }],
      }).success,
      false,
      key,
    );
  }
  for (const field of [
    { required: "true" },
    { disabled: 0 },
    { readonly: null },
    { value: 7 },
    { constraints: { min: 2 } },
    { options: null },
    { options: [null] },
    { options: [{ label: "Plan", value: 1, disabled: false }] },
    { options: [{ label: "Plan", value: "plan", disabled: "false" }] },
    { group: false },
    { help: [] },
    { validationMessage: 1 },
    { ref: false },
  ])
    assert.equal(
      nativeFormSchema.safeParse({
        ...native,
        fields: [{ ...native.fields[0], ...field }],
      }).success,
      false,
      JSON.stringify(field),
    );
  for (const value of [
    null,
    {},
    { ...native, fallback: "unsupported" },
    { ...native, fields: Array(1) },
    { ...native, outside: Array(1) },
    { ...native, feedback: Array(1) },
    { ...native, fields: [{ ...native.fields[0], options: Array(1) }] },
  ])
    assert.equal(nativeFormSchema.safeParse(value).success, false);
});

test("native schema preserves exact values, optional metadata, and unknown properties", () => {
  const value = {
    ...native,
    extension: { version: 3 },
    fields: [
      {
        ...native.fields[0],
        value: false,
        constraints: { min: "2020-01-01", step: "01" },
        group: "",
        help: " text ",
        validationMessage: "",
        ref: "e1",
        extra: 9,
        options: [
          { label: " Business ", value: "biz", disabled: false, extra: true },
        ],
      },
    ],
  };
  assert.deepEqual(nativeFormSchema.safeParse(value).data, value);
});
