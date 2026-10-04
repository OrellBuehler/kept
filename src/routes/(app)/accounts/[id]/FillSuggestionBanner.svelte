<script lang="ts">
  import { enhance } from "$app/forms";
  import { toast } from "svelte-sonner";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { plural } from "$lib/import-ui";
  import { transferSummary } from "$lib/transfer-ui";
  import ArrowLeftRightIcon from "@lucide/svelte/icons/arrow-left-right";

  let { count }: { count: number } = $props();

  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  function report(data: Record<string, unknown> | undefined) {
    const paired = Number(data?.paired ?? 0);
    const mirrored = Number(data?.mirrored ?? 0);
    const needsAmount = Number(data?.needsAmount ?? 0);
    toast.success("Filled from transfers", {
      description:
        transferSummary({ linked: paired, mirrored, needsAmount }) ??
        "Nothing to fill in.",
    });
  }
</script>

<Alert.Root>
  <ArrowLeftRightIcon />
  <Alert.Title>Fill this account from transfers?</Alert.Title>
  <Alert.Description>
    <p>
      Found {plural(count, "transfer")} to this account in your other accounts. Fill
      {count === 1 ? "it" : "them"} in?
    </p>
    <form
      method="POST"
      action="?/enableFillFromTransfers"
      class="mt-3 grid gap-2"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        onSuccessData: report,
      })}
    >
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {#if pending}<Spinner />{/if}
          Fill them in
        </Button>
      </div>
      {#if errors.form?.length}
        <p class="text-destructive text-sm" role="alert">
          {errors.form.join(" ")}
        </p>
      {/if}
    </form>
  </Alert.Description>
</Alert.Root>
