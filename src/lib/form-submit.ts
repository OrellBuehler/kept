import { applyAction } from "$app/forms";
import type { SubmitFunction } from "@sveltejs/kit";
import { toast } from "svelte-sonner";

import type { FormErrors } from "$lib/form-errors";

type Errors = NonNullable<FormErrors>;

/**
 * Move error keys the form does not render into `form`, so a failure is never
 * silent. Without `knownFields` the errors are returned unchanged.
 */
export function foldErrors(
  errors: Errors,
  knownFields: readonly string[] | undefined,
): Errors {
  if (!knownFields) return errors;
  const out: Errors = {};
  const form = [...(errors.form ?? [])];
  for (const [key, messages] of Object.entries(errors)) {
    if (key === "form") continue;
    if (knownFields.includes(key)) out[key] = messages;
    else form.push(...messages.filter((m) => !form.includes(m)));
  }
  if (form.length > 0) out.form = form;
  return out;
}

interface Options {
  setPending: (pending: boolean) => void;
  setErrors: (errors: Errors) => void;
  /** Fields the form renders; other error keys are folded into `form`. */
  knownFields?: readonly string[];
  onSuccess?: () => void;
  /** Toast shown after a successful submit. */
  successMessage?: string;
}

const GENERIC = "Something went wrong. Please try again.";

/**
 * `use:enhance` callback wiring pending state, field errors and toasts.
 * Inputs are never reset; dialogs re-mount their content when reopened.
 */
export function submitHandler(opts: Options): SubmitFunction {
  return () => {
    opts.setPending(true);
    opts.setErrors({});
    return async ({ result, update }) => {
      opts.setPending(false);
      if (result.type === "success") {
        if (opts.successMessage) toast.success(opts.successMessage);
        opts.onSuccess?.();
        await update({ reset: false });
      } else if (result.type === "failure") {
        const errors = foldErrors(
          (result.data?.errors ?? {}) as Errors,
          opts.knownFields,
        );
        opts.setErrors(
          Object.keys(errors).length ? errors : { form: [GENERIC] },
        );
      } else if (result.type === "redirect") {
        if (opts.successMessage) toast.success(opts.successMessage);
        opts.onSuccess?.();
        await applyAction(result);
      } else {
        console.error("form submission failed", result.error);
        opts.setErrors({ form: [GENERIC] });
        toast.error(GENERIC);
      }
    };
  };
}
