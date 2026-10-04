<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { COLOR_PALETTE } from "$lib/account-types";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import InstitutionLogo from "$lib/components/InstitutionLogo.svelte";
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
      logoVersion: string | null;
    } | null;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let color = $state("");
  let removeLogo = $state(false);
  let logoPreview = $state<string | null>(null);
  const MAX_LOGO_BYTES = 512 * 1024;

  function setLogoPreview(file: File | null) {
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    logoPreview = file ? URL.createObjectURL(file) : null;
  }

  $effect(() => () => setLogoPreview(null));

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      color = institution?.color ?? "";
      removeLogo = false;
      setLogoPreview(null);
    });
  });

  const editing = $derived(institution !== null);

  function onLogoChange(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    if (file && file.size > MAX_LOGO_BYTES) {
      errors = { ...errors, logo: ["The logo is larger than 512 KB."] };
      e.currentTarget.value = "";
      setLogoPreview(null);
      return;
    }
    errors = { ...errors, logo: [] };
    setLogoPreview(file ?? null);
    if (file) removeLogo = false;
  }
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
      enctype="multipart/form-data"
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: ["name", "bic", "color", "logo"],
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
      <FormField
        label="Logo (optional)"
        for="{uid}-logo"
        errors={errors.logo}
        hint="PNG, JPEG, WebP or SVG, up to 512 KB."
      >
        <div class="flex items-center gap-3">
          {#if logoPreview}
            <img
              src={logoPreview}
              alt=""
              class="bg-background size-12 shrink-0 rounded-md border object-contain p-0.5"
            />
          {:else if institution}
            <InstitutionLogo
              institution={removeLogo
                ? { ...institution, logoVersion: null }
                : institution}
              size="lg"
            />
          {/if}
          <Input
            id="{uid}-logo"
            name="logo"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg"
            onchange={onLogoChange}
            aria-invalid={!!errors.logo?.length}
          />
        </div>
        {#if institution?.logoVersion}
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="removeLogo"
              value="1"
              bind:checked={removeLogo}
              disabled={!!logoPreview}
            />
            Remove current logo
          </label>
        {/if}
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
        <p class="text-destructive text-sm" role="alert">
          {errors.form.join(" ")}
        </p>
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
