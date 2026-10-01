<script lang="ts">
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import { Button } from "$lib/components/ui/button/index.js";
  import CopyButton from "$lib/components/app/copy-button.svelte";

  let {
    secret,
    ondismiss,
  }: {
    secret: string;
    ondismiss: () => void;
  } = $props();
</script>

<div
  role="status"
  class="grid gap-3 rounded-lg border border-amber-500/50 bg-amber-50 p-4 text-sm dark:bg-amber-400/10"
>
  <div class="flex items-start gap-2">
    <KeyRoundIcon
      class="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
    />
    <div class="grid gap-1">
      <p class="font-medium text-amber-900 dark:text-amber-200">
        Your webhook secret
      </p>
      <p class="text-amber-900/90 dark:text-amber-200/90">
        Copy it now and paste it into the Paperless workflow. You won't see it
        again; Kept stores only a hash. If you lose it, rotate the secret.
      </p>
    </div>
  </div>
  <code
    class="bg-background block rounded-md border px-3 py-2 font-mono text-xs break-all select-all"
    >{secret}</code
  >
  <div class="flex flex-wrap gap-2">
    <CopyButton
      value={secret}
      label="Copy secret"
      copiedMessage="Secret copied"
    />
    <Button type="button" variant="ghost" size="sm" onclick={ondismiss}>
      I have saved it
    </Button>
  </div>
</div>
