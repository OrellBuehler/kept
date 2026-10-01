<script lang="ts">
  import CopyIcon from "@lucide/svelte/icons/copy";
  import CheckIcon from "@lucide/svelte/icons/check";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";

  let {
    value,
    label = "Copy",
    copiedMessage = "Copied",
    iconOnly = false,
  }: {
    value: string;
    label?: string;
    copiedMessage?: string;
    iconOnly?: boolean;
  } = $props();

  import { onDestroy } from "svelte";

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      toast.success(copiedMessage);
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 2000);
    } catch (err) {
      console.error("clipboard write failed", err);
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }
</script>

<Button
  type="button"
  variant="outline"
  size={iconOnly ? "icon" : "sm"}
  onclick={copy}
  aria-label={iconOnly ? label : undefined}
>
  {#if copied}<CheckIcon />{:else}<CopyIcon />{/if}
  {#if !iconOnly}{copied ? "Copied" : label}{/if}
</Button>
