<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Empty from "$lib/components/ui/empty";

  const status = $derived(page.status);
  const title = $derived(
    status === 404
      ? "Page not found"
      : status === 403
        ? "Access denied"
        : status >= 500
          ? "Something went wrong"
          : "Request failed",
  );
  const description = $derived.by(() => {
    if (status === 404) return "The page you are looking for does not exist.";
    if (status === 403) return "You do not have permission to view this page.";
    if (status >= 500)
      return "An unexpected error occurred. Please try again in a moment.";
    return page.error?.message || "The request could not be completed.";
  });
  const errorId = $derived(page.error?.errorId);
</script>

<Empty.Root class="border border-dashed">
  <Empty.Header>
    <Empty.Media variant="icon"><TriangleAlertIcon /></Empty.Media>
    <Empty.Title>{status} · {title}</Empty.Title>
    <Empty.Description>{description}</Empty.Description>
  </Empty.Header>
  <Empty.Content>
    {#if errorId}
      <p class="text-muted-foreground text-xs">
        Error id: <code class="font-mono">{errorId}</code>
      </p>
    {/if}
    <Button href={resolve("/(app)")} variant="outline">Back to dashboard</Button
    >
  </Empty.Content>
</Empty.Root>
