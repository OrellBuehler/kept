import { applyAction } from "$app/forms";
import type { SubmitFunction } from "@sveltejs/kit";
import { toast } from "svelte-sonner";

export type FormErrors = Record<string, string[]>;

interface Options {
  setPending: (pending: boolean) => void;
  setErrors: (errors: FormErrors) => void;
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
        const errors = (result.data?.errors ?? {}) as FormErrors;
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
