<script lang="ts">
  import { enhance } from "$app/forms";
  import SendIcon from "@lucide/svelte/icons/send";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as NativeSelect from "$lib/components/ui/native-select/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { lastFullMonth } from "$lib/format";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { PageData } from "./$types";

  let { accounts }: { accounts: PageData["accounts"] } = $props();

  const KINDS = [
    { value: "statement", label: "Account statement" },
    { value: "bills", label: "Bills" },
    { value: "net-worth", label: "Net worth" },
  ] as const;

  const defaults = lastFullMonth();

  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let kind = $state<string>("statement");
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Send a report to Paperless</Card.Title>
    <Card.Description>
      Builds the PDF report and stores it in Paperless as a document. Sending
      the same report twice does nothing.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    <form
      method="POST"
      action="?/uploadReport"
      class="grid grid-cols-[minmax(0,1fr)] gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: ["kind", "account", "from", "to"],
      })}
    >
      <FormAlert message={formError(errors)} />
      <FormField label="Report" for="report-kind" errors={errors.kind}>
        <NativeSelect.Root
          id="report-kind"
          name="kind"
          bind:value={kind}
          class="w-full sm:w-64"
          aria-invalid={!!errors.kind}
        >
          {#each KINDS as k (k.value)}
            <NativeSelect.Option value={k.value}>{k.label}</NativeSelect.Option>
          {/each}
        </NativeSelect.Root>
      </FormField>

      {#if kind === "statement"}
        {#if accounts.length === 0}
          <p class="text-muted-foreground text-sm">
            There are no accounts yet. Add an account to send a statement.
          </p>
        {:else}
          <div class="grid gap-4 sm:grid-cols-3">
            <FormField
              label="Account"
              for="report-account"
              errors={errors.account}
              class="sm:col-span-3"
            >
              <NativeSelect.Root
                id="report-account"
                name="account"
                value=""
                class="w-full sm:w-64"
                required
                aria-invalid={!!errors.account}
              >
                <NativeSelect.Option value="" disabled
                  >Choose an account…</NativeSelect.Option
                >
                {#each accounts as a (a.id)}
                  <NativeSelect.Option value={a.id}>
                    {a.name}{a.archived ? " (archived)" : ""}
                  </NativeSelect.Option>
                {/each}
              </NativeSelect.Root>
            </FormField>
            <FormField label="From" for="report-from" errors={errors.from}>
              <Input
                id="report-from"
                name="from"
                type="date"
                required
                value={defaults.from}
                aria-invalid={!!errors.from}
              />
            </FormField>
            <FormField label="To" for="report-to" errors={errors.to}>
              <Input
                id="report-to"
                name="to"
                type="date"
                required
                value={defaults.to}
                aria-invalid={!!errors.to}
              />
            </FormField>
          </div>
        {/if}
      {/if}

      <Button
        type="submit"
        disabled={pending || (kind === "statement" && accounts.length === 0)}
        class="self-start"
      >
        {#if pending}<Spinner />Sending…{:else}<SendIcon />Send to Paperless{/if}
      </Button>
    </form>
  </Card.Content>
</Card.Root>
