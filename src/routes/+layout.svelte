<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  let { children } = $props();

  const UPDATE_TOAST = "pwa-update";

  onMount(() => {
    let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;

    async function applyUpdate(event: MouseEvent) {
      event.preventDefault();
      toast.loading("Updating Kept...", { id: UPDATE_TOAST });
      try {
        await updateSW?.(true);
      } catch (err) {
        console.error("Could not apply the update", err);
        toast.error("Could not update. Reload the page to try again.", {
          id: UPDATE_TOAST,
          duration: Infinity,
        });
      }
    }

    import("virtual:pwa-register")
      .then(({ registerSW }) => {
        updateSW = registerSW({
          onNeedRefresh() {
            toast.info("A new version of Kept is available", {
              id: UPDATE_TOAST,
              duration: Infinity,
              action: { label: "Reload", onClick: applyUpdate },
            });
          },
          onRegisterError(err) {
            console.error("Service worker registration failed", err);
          },
        });
      })
      .catch((err) => console.error("Could not load the service worker", err));
  });
</script>

<ModeWatcher disableHeadScriptInjection />
<Toaster richColors closeButton />

{@render children()}
