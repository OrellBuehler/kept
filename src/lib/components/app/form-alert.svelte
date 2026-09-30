<script lang="ts">
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import * as Alert from "$lib/components/ui/alert/index.js";

  let { message }: { message: string | undefined } = $props();
</script>

{#if message}
  <Alert.Root
    variant="destructive"
    role="alert"
    class="border-destructive/40 dark:text-red-400 dark:*:data-[slot=alert-description]:text-red-400"
  >
    <CircleAlertIcon />
    <Alert.Description>{message}</Alert.Description>
  </Alert.Root>
{/if}
