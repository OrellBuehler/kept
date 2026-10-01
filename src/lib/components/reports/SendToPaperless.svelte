<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { toast } from "svelte-sonner";
  import SendIcon from "@lucide/svelte/icons/send";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";

  let {
    kind,
    fields = {},
    disabled = false,
  }: {
    kind: "statement" | "bills" | "net-worth";
    fields?: Record<string, string>;
    disabled?: boolean;
  } = $props();

  const GENERIC = "Something went wrong. Please try again.";

  let pending = $state(false);
  let errors = $state<string[]>([]);

  function firstErrors(data: unknown): string[] {
    const all = (data as { errors?: Record<string, string[]> } | undefined)
      ?.errors;
    return Object.values(all ?? {}).flat();
  }
</script>

<form
  method="POST"
  action="{resolve('/(app)/settings/paperless')}?/uploadReport"
  use:enhance={() => {
    pending = true;
    errors = [];
    return async ({ result }) => {
      pending = false;
      if (result.type === "success") {
        const upload = (
          result.data as {
            alreadyUploaded?: boolean;
            upload?: { status: string };
          }
        ).upload;
        const already = (result.data as { alreadyUploaded?: boolean })
          .alreadyUploaded;
        if (already) toast.success("Already sent");
        else if (upload?.status === "pending") toast.success("Upload queued");
        else if (upload?.status === "failed") {
          errors = ["Paperless did not accept the upload."];
        } else toast.success("Sent to Paperless");
      } else if (result.type === "failure") {
        const list = firstErrors(result.data);
        errors = list.length ? list : [GENERIC];
      } else {
        console.error("report upload failed", result.type);
        errors = [GENERIC];
        toast.error(GENERIC);
      }
    };
  }}
  class="grid gap-2"
>
  <input type="hidden" name="kind" value={kind} />
  {#each Object.entries(fields) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}
  <div>
    <Button
      type="submit"
      variant="outline"
      disabled={disabled || pending}
      aria-busy={pending}
    >
      {#if pending}
        <Spinner />
        Sending
      {:else}
        <SendIcon />
        Send to Paperless
      {/if}
    </Button>
  </div>
  {#if errors.length}
    <p class="text-destructive text-sm" role="alert">
      {errors[0]}
      <a
        class="underline underline-offset-2"
        href={resolve("/(app)/settings/paperless")}>Paperless settings</a
      >
    </p>
  {/if}
</form>
