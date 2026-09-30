<script lang="ts">
  import { enhance } from "$app/forms";
  import type { Snippet } from "svelte";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import { submitHandler, type FormErrors } from "$lib/form-submit";

  let {
    open = $bindable(false),
    title,
    description,
    action,
    fields = {},
    confirmLabel = "Delete",
    successMessage,
    confirmText,
    children,
  }: {
    open?: boolean;
    title: string;
    description: string;
    action: string;
    fields?: Record<string, string>;
    confirmLabel?: string;
    successMessage?: string;
    /** When set, the user must type this text to enable the confirm button. */
    confirmText?: string;
    children?: Snippet;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<FormErrors>({});
  let typed = $state("");

  const confirmed = $derived(
    confirmText === undefined || typed.trim() === confirmText,
  );

  $effect(() => {
    if (open) {
      errors = {};
      typed = "";
    }
  });
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content class="max-h-[90dvh] overflow-y-auto">
    <form
      method="POST"
      {action}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        successMessage,
        onSuccess: () => (open = false),
      })}
    >
      <AlertDialog.Header>
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>{description}</AlertDialog.Description>
      </AlertDialog.Header>
      {@render children?.()}
      {#each Object.entries(fields) as [name, value] (name)}
        <input type="hidden" {name} {value} />
      {/each}
      {#if confirmText !== undefined}
        <div class="grid gap-1.5">
          <label for="{uid}-confirm" class="text-sm">
            Type <span class="font-mono font-semibold">{confirmText}</span> to confirm
          </label>
          <Input
            id="{uid}-confirm"
            bind:value={typed}
            autocomplete="off"
            disabled={pending}
          />
        </div>
      {/if}
      {#each Object.values(errors).flat() as message (message)}
        <p class="text-destructive text-sm" role="alert">{message}</p>
      {/each}
      <AlertDialog.Footer>
        <AlertDialog.Cancel type="button" disabled={pending}>
          Cancel
        </AlertDialog.Cancel>
        <Button
          type="submit"
          variant="destructive"
          disabled={pending || !confirmed}
        >
          {#if pending}<Spinner />{/if}
          {confirmLabel}
        </Button>
      </AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
