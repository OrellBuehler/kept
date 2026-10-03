<script lang="ts">
  import { enhance } from "$app/forms";
  import { toast } from "svelte-sonner";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import LocalTime from "$lib/components/app/local-time.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { CHANNEL_LABELS } from "$lib/notification-types";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let triggerPending = $state(false);
  let triggerErrors = $state<NonNullable<FormErrors>>({});
  let pending = $state<string | null>(null);
  let channelErrors = $state<Record<string, NonNullable<FormErrors>>>({});

  const hints = {
    ntfy: "Messages are published to this topic. Add an access token if the topic is protected.",
    webhook:
      "Kept POSTs JSON ({source, title, message, sentAt}). With a secret, the request carries x-kept-signature: sha256=<HMAC-SHA256 of the body>.",
    email: "Sent through the SMTP server your administrator configured.",
  } as const;

  const view = (kind: string) => data.channels.find((c) => c.kind === kind);

  const channelHandler = (kind: string, message?: string) =>
    submitHandler({
      setPending: (v) => (pending = v ? kind : null),
      setErrors: (e) => (channelErrors[kind] = e),
      successMessage: message,
    });
</script>

<div class="grid grid-cols-[minmax(0,1fr)] gap-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Triggers</Card.Title>
      <Card.Description>
        Kept checks hourly and sends one message with everything new. Each event
        is only reported once. Messages go to your channels below and may
        contain amounts and names.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        method="POST"
        action="?/saveSettings"
        class="grid gap-5"
        use:enhance={submitHandler({
          setPending: (v) => (triggerPending = v),
          setErrors: (e) => (triggerErrors = e),
          successMessage: "Triggers saved.",
        })}
      >
        <div class="flex flex-wrap items-center gap-3">
          <Switch
            id="billDueEnabled"
            name="billDueEnabled"
            checked={data.settings.billDueEnabled}
          />
          <Label for="billDueEnabled">Bill due within</Label>
          <Input
            name="billDueDays"
            type="number"
            min="1"
            max="60"
            class="w-20"
            aria-label="Days before due date"
            value={data.settings.billDueDays}
          />
          <span class="text-sm">days</span>
        </div>
        {#if triggerErrors.billDueDays}
          <p class="text-destructive text-sm" role="alert">
            {triggerErrors.billDueDays[0]}
          </p>
        {/if}
        <div class="flex items-center gap-3">
          <Switch
            id="billOverdueEnabled"
            name="billOverdueEnabled"
            checked={data.settings.billOverdueEnabled}
          />
          <Label for="billOverdueEnabled">Bill overdue</Label>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <Switch
            id="budgetEnabled"
            name="budgetEnabled"
            checked={data.settings.budgetEnabled}
          />
          <Label for="budgetEnabled">Monthly budget reaches</Label>
          <Input
            name="budgetPercent"
            type="number"
            min="1"
            max="200"
            class="w-20"
            aria-label="Percent of budget"
            value={data.settings.budgetPercent}
          />
          <span class="text-sm">%</span>
        </div>
        {#if triggerErrors.budgetPercent}
          <p class="text-destructive text-sm" role="alert">
            {triggerErrors.budgetPercent[0]}
          </p>
        {/if}
        <div class="flex flex-wrap items-center gap-3">
          <Switch
            id="staleImportEnabled"
            name="staleImportEnabled"
            checked={data.settings.staleImportEnabled}
          />
          <Label for="staleImportEnabled">Account not imported for</Label>
          <Input
            name="staleImportDays"
            type="number"
            min="1"
            max="365"
            class="w-20"
            aria-label="Days without an import"
            value={data.settings.staleImportDays}
          />
          <span class="text-sm">days</span>
        </div>
        {#if triggerErrors.staleImportDays}
          <p class="text-destructive text-sm" role="alert">
            {triggerErrors.staleImportDays[0]}
          </p>
        {/if}
        <FormAlert message={formError(triggerErrors)} />
        <Button type="submit" disabled={triggerPending} class="self-start">
          {#if triggerPending}<Spinner />Saving…{:else}Save triggers{/if}
        </Button>
      </form>
    </Card.Content>
  </Card.Root>

  {#each data.kinds as kind (kind)}
    {@const channel = view(kind)}
    {@const errors = channelErrors[kind] ?? {}}
    <Card.Root>
      <Card.Header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Card.Title>{CHANNEL_LABELS[kind]}</Card.Title>
          {#if channel}
            <Badge variant={channel.enabled ? "default" : "secondary"}>
              {channel.enabled ? "Enabled" : "Paused"}
            </Badge>
          {/if}
        </div>
        <Card.Description>{hints[kind]}</Card.Description>
      </Card.Header>
      <Card.Content class="grid grid-cols-[minmax(0,1fr)] gap-4">
        <form
          method="POST"
          action="?/saveChannel"
          class="grid gap-4"
          use:enhance={channelHandler(kind, "Saved.")}
        >
          <input type="hidden" name="kind" value={kind} />
          {#if kind === "ntfy"}
            <FormField
              label="Server"
              for="ntfy-serverUrl"
              errors={errors.serverUrl}
            >
              <Input
                id="ntfy-serverUrl"
                name="serverUrl"
                type="url"
                required
                placeholder="https://ntfy.sh"
                value={channel?.fields.serverUrl ?? ""}
              />
            </FormField>
            <FormField label="Topic" for="ntfy-topic" errors={errors.topic}>
              <Input
                id="ntfy-topic"
                name="topic"
                required
                autocomplete="off"
                value={channel?.fields.topic ?? ""}
              />
            </FormField>
            <FormField
              label="Access token (optional)"
              for="ntfy-token"
              errors={errors.token}
              hint={channel?.hasSecret
                ? "A token is stored. Leave blank to keep it."
                : "Stored encrypted, never shown again."}
            >
              <Input
                id="ntfy-token"
                name="token"
                type="password"
                autocomplete="new-password"
              />
            </FormField>
          {:else if kind === "webhook"}
            <FormField label="URL" for="webhook-url" errors={errors.url}>
              <Input
                id="webhook-url"
                name="url"
                type="url"
                required
                placeholder="https://example.org/hooks/kept"
                value={channel?.fields.url ?? ""}
              />
            </FormField>
            <FormField
              label="Signing secret (optional)"
              for="webhook-secret"
              errors={errors.secret}
              hint={channel?.hasSecret
                ? "A secret is stored. Leave blank to keep it."
                : "Stored encrypted, never shown again."}
            >
              <Input
                id="webhook-secret"
                name="secret"
                type="password"
                autocomplete="new-password"
              />
            </FormField>
          {:else}
            <FormField label="Send to" for="email-to" errors={errors.to}>
              <Input
                id="email-to"
                name="to"
                type="email"
                required
                value={channel?.fields.to ?? ""}
              />
            </FormField>
          {/if}
          <FormAlert message={formError(errors)} />
          <Button type="submit" disabled={pending === kind} class="self-start">
            {#if pending === kind}<Spinner />Saving…{:else}{channel
                ? "Save changes"
                : "Add channel"}{/if}
          </Button>
        </form>

        {#if channel}
          <div class="grid gap-3 border-t pt-4">
            <div class="flex flex-wrap items-center gap-3">
              <form
                method="POST"
                action="?/testChannel"
                use:enhance={() => {
                  pending = `test-${kind}`;
                  return async ({ result, update }) => {
                    pending = null;
                    if (
                      result.type === "success" &&
                      result.data &&
                      "result" in result.data
                    ) {
                      const r = result.data.result as
                        { ok: true } | { ok: false; reason: string };
                      if (r.ok) toast.success("Test message sent.");
                      else toast.error(r.reason);
                    }
                    await update();
                  };
                }}
              >
                <input type="hidden" name="kind" value={kind} />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={pending === `test-${kind}`}
                >
                  {#if pending === `test-${kind}`}<Spinner />Sending…{:else}Send
                    test{/if}
                </Button>
              </form>
              <form
                method="POST"
                id="toggle-{kind}"
                action="?/toggleChannel"
                class="flex items-center gap-2"
                use:enhance={channelHandler(kind)}
              >
                <input type="hidden" name="kind" value={kind} />
                <input
                  type="hidden"
                  name="enabled"
                  value={String(!channel.enabled)}
                />
                <Switch
                  id="enabled-{kind}"
                  checked={channel.enabled}
                  onCheckedChange={() =>
                    document
                      .querySelector<HTMLFormElement>(`#toggle-${kind}`)
                      ?.requestSubmit()}
                />
                <Label for="enabled-{kind}">Enabled</Label>
              </form>
              <form
                method="POST"
                action="?/deleteChannel"
                class="ms-auto"
                use:enhance={channelHandler(kind, "Removed.")}
              >
                <input type="hidden" name="kind" value={kind} />
                <Button
                  type="submit"
                  variant="ghost"
                  class="text-destructive hover:text-destructive"
                >
                  Remove
                </Button>
              </form>
            </div>
            <dl
              class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm"
              aria-label="Delivery status"
            >
              <dt class="text-muted-foreground">Last delivery</dt>
              <dd>
                {#if channel.lastSuccessAt}
                  <LocalTime ms={channel.lastSuccessAt} />
                {:else}
                  Never
                {/if}
              </dd>
              {#if channel.lastError && channel.lastErrorAt}
                <dt class="text-muted-foreground">Last error</dt>
                <dd class="text-destructive min-w-0 break-words">
                  {channel.lastError}
                  (<LocalTime ms={channel.lastErrorAt} />)
                </dd>
              {/if}
            </dl>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  {/each}

  {#if !data.kinds.includes("email")}
    <p class="text-muted-foreground text-sm">
      Email is not available: the administrator has not configured an SMTP
      server.
    </p>
  {/if}
</div>
