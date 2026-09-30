<script lang="ts">
  import { enhance } from "$app/forms";
  import FileUpIcon from "@lucide/svelte/icons/file-up";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { cn } from "$lib/utils";

  const MAX_BYTES = 20 * 1024 * 1024;

  let {
    action,
    title = "Drop a PDF here or click to choose",
    hint = "QR-bill or invoice, up to 20 MB",
    pendingLabel = "Reading the bill…",
    successMessage,
    compact = false,
  }: {
    action: string;
    title?: string;
    hint?: string;
    pendingLabel?: string;
    successMessage?: string;
    compact?: boolean;
  } = $props();

  const uid = $props.id();
  let formEl = $state<HTMLFormElement>();
  let input = $state<HTMLInputElement>();
  let pending = $state(false);
  let dragging = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  const messages = $derived(Object.values(errors).flat());

  function submitIfValid() {
    const file = input?.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      errors = { file: ["The file is larger than 20 MB."] };
      if (input) input.value = "";
      return;
    }
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      errors = { file: ["Choose a PDF file."] };
      if (input) input.value = "";
      return;
    }
    formEl?.requestSubmit();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files?.[0];
    if (!file || !input || pending) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    submitIfValid();
  }
</script>

<form
  bind:this={formEl}
  method="POST"
  {action}
  enctype="multipart/form-data"
  class="grid gap-2"
  use:enhance={submitHandler({
    setPending: (v) => (pending = v),
    setErrors: (e) => {
      errors = e;
      if (Object.keys(e).length > 0 && input) input.value = "";
    },
    knownFields: ["file"],
    successMessage,
    onSuccess: () => {
      if (input) input.value = "";
    },
  })}
>
  <label
    for="{uid}-file"
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
    class={cn(
      "focus-within:ring-ring/50 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-center transition-colors focus-within:ring-[3px]",
      compact ? "py-4" : "py-10",
      dragging ? "border-primary bg-primary/5" : "hover:bg-muted/50",
      pending && "pointer-events-none opacity-70",
    )}
  >
    {#if pending}
      <Spinner class="size-6" />
      <span class="text-sm font-medium" aria-hidden="true">{pendingLabel}</span>
    {:else}
      <FileUpIcon class="text-muted-foreground size-6" />
      <span class="text-sm font-medium">{title}</span>
      <span class="text-muted-foreground text-xs">{hint}</span>
    {/if}
    <input
      bind:this={input}
      id="{uid}-file"
      type="file"
      name="file"
      accept="application/pdf,.pdf"
      class="sr-only"
      disabled={pending}
      onchange={submitIfValid}
    />
  </label>
  <div aria-live="polite" role="status" class="text-sm">
    {#if pending}
      <span class="sr-only">{pendingLabel}</span>
    {:else if messages.length}
      <p class="text-destructive">{messages.join(" ")}</p>
    {/if}
  </div>
</form>
