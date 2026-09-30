<script lang="ts">
  import { enhance } from "$app/forms";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { COLOR_PALETTE } from "$lib/account-types";
  import { submitHandler, type FormErrors } from "$lib/form-submit";
  import { cn } from "$lib/utils";
  import CheckIcon from "@lucide/svelte/icons/check";

  let {
    open = $bindable(false),
    institution = null,
  }: {
    open?: boolean;
    institution?: {
      id: string;
      name: string;
      bic: string | null;
      color: string | null;
    } | null;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<FormErrors>({});
  let color = $state("");

  $effect(() => {
    if (open) {
      errors = {};
      color = institution?.color ?? "";
    }
  });

  const editing = $derived(institution !== null);
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title
        >{editing ? "Edit institution" : "Add institution"}</Dialog.Title
      >
      <Dialog.Description>
        A bank, broker or pension fund that holds your accounts.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action={editing ? "?/updateInstitution" : "?/createInstitution"}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        successMessage: editing ? "Institution updated" : "Institution added",
        onSuccess: () => (open = false),
      })}
    >
      {#if institution}
        <input type="hidden" name="id" value={institution.id} />
      {/if}
      <FormField label="Name" for="{uid}-name" errors={errors.name}>
        <Input
          id="{uid}-name"
          name="name"
          required
          maxlength={80}
          placeholder="Example Bank"
          value={institution?.name ?? ""}
          aria-invalid={!!errors.name}
        />
      </FormField>
      <FormField
        label="BIC (optional)"
        for="{uid}-bic"
        errors={errors.bic}
        hint="8 or 11 characters."
      >
        <Input
          id="{uid}-bic"
          name="bic"
          maxlength={11}
          class="font-mono uppercase"
          placeholder="EXAMCHZZ"
          autocapitalize="characters"
          value={institution?.bic ?? ""}
          aria-invalid={!!errors.bic}
        />
      </FormField>
      <div class="grid gap-1.5">
        <span class="text-sm leading-none font-medium">Colour</span>
        <input type="hidden" name="color" value={color} />
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class={cn(
              "text-muted-foreground flex h-7 items-center rounded-full border px-2.5 text-xs",
              color === "" && "border-foreground text-foreground",
            )}
            aria-pressed={color === ""}
            onclick={() => (color = "")}
          >
            None
          </button>
          {#each COLOR_PALETTE as swatch (swatch)}
            <button
              type="button"
              class={cn(
                "flex size-7 items-center justify-center rounded-full border-2 border-transparent text-white",
                color === swatch && "border-foreground",
              )}
              style:background-color={swatch}
              aria-label="Colour {swatch}"
              aria-pressed={color === swatch}
              onclick={() => (color = swatch)}
            >
              {#if color === swatch}<CheckIcon class="size-3.5" />{/if}
            </button>
          {/each}
          <label
            class="text-muted-foreground flex items-center gap-1.5 text-xs"
          >
            Custom
            <input
              type="color"
              class="bg-background size-7 cursor-pointer rounded-full border p-0.5 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
              value={color || "#64748b"}
              oninput={(e) => (color = e.currentTarget.value)}
              aria-label="Custom colour"
            />
          </label>
        </div>
        {#if errors.color?.length}
          <p class="text-destructive text-sm" role="alert">{errors.color[0]}</p>
        {/if}
      </div>
      {#if errors.form?.length}
        <p class="text-destructive text-sm" role="alert">{errors.form[0]}</p>
      {/if}
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (open = false)}
          disabled={pending}>Cancel</Button
        >
        <Button type="submit" disabled={pending}>
          {#if pending}<Spinner />{/if}
          {editing ? "Save" : "Add institution"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
