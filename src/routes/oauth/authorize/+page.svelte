<script lang="ts">
  import { enhance } from "$app/forms";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
  import { formError } from "$lib/form-errors";
  import { foldErrors } from "$lib/form-submit";
  import AccessFields from "$lib/components/app/access-fields.svelte";
  import AdminConfirmFields from "$lib/components/app/admin-confirm-fields.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const uid = $props.id();
  const KNOWN_FIELDS = [
    "scopes",
    "categoryIds",
    "accountIds",
    "expires",
    "adminPassword",
    "adminCode",
  ];

  // The page is loaded once per request: the choices start from what was asked for.
  // svelte-ignore state_referenced_locally
  let scopes = $state<string[]>([...(data.consent?.scopes ?? [])]);
  let restrict = $state(false);
  let categoryIds = $state<string[]>([]);
  let restrictAccounts = $state(false);
  let accountIds = $state<string[]>([]);
  let granted = $state<string[]>([]);
  let pending = $state(false);
  let errors = $state<Record<string, string[]>>({});
  let leaving = $state<string | null>(null);

  // Without JavaScript the answer is the form result itself: a link finishes the sign-in.
  const continueTo = $derived(
    leaving ??
      (form && "redirectTo" in form && typeof form.redirectTo === "string"
        ? form.redirectTo
        : null),
  );
  let leftDenied = $state(false);
  const denied = $derived(leftDenied || (form ? "denied" in form : false));
  const clientName = $derived(
    data.consent?.clientName ??
      (form && "clientName" in form && typeof form.clientName === "string"
        ? form.clientName
        : "the application"),
  );
  const failure = $derived(form && "values" in form ? form : null);
  const writeScopes = $derived(
    new Set<string>(
      data.scopeGroups.find((g) => g.title === "Write")?.scopes ?? [],
    ),
  );
  // Before hydration `granted` is still empty: the ticked permissions stand in for it.
  const writes = $derived(
    (granted.length > 0 ? granted : scopes).filter((s) => writeScopes.has(s)),
  );

  function leave(d: Record<string, unknown> | undefined) {
    if (d && typeof d.redirectTo === "string") {
      leftDenied = d.denied === true;
      leaving = d.redirectTo;
      window.location.assign(d.redirectTo);
    }
  }
</script>

<svelte:head>
  <title>Connect an app · Kept</title>
</svelte:head>

<main class="mx-auto grid w-full max-w-2xl gap-6 p-4 py-8">
  <Card.Root>
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        <ShieldCheckIcon class="size-5" /> Connect an app to Kept
      </Card.Title>
      <Card.Description>
        An application is asking for access to your Kept data through the MCP
        server. Nothing is shared until you allow it.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-6">
      {#if continueTo}
        <p class="text-sm">
          {#if denied}Access denied.{:else}Access granted.{/if}
          Returning to the application… If nothing happens, continue manually.
        </p>
        <div>
          <Button href={continueTo} data-sveltekit-reload>
            Continue to {clientName}
          </Button>
        </div>
      {:else if data.consent}
        <dl
          class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border p-4 text-sm"
        >
          <dt class="text-muted-foreground">Application</dt>
          <dd class="font-medium break-words">{data.consent.clientName}</dd>
          {#if data.consent.clientUri}
            <dt class="text-muted-foreground">It says it is at</dt>
            <dd class="break-all">{data.consent.clientUri}</dd>
          {/if}
          <dt class="text-muted-foreground">Sends you back to</dt>
          <dd class="font-mono text-xs break-all">
            {data.consent.redirectUri}
          </dd>
        </dl>
        <p class="text-muted-foreground text-xs">
          The application's name is whatever it called itself when it
          registered: Kept cannot check it. Allow it only if you just started
          this connection yourself.
        </p>
        {#if !data.consent.redirectIsLoopback}
          <Alert.Root class="border-destructive/40">
            <TriangleAlertIcon />
            <Alert.Title>This sends you to another website</Alert.Title>
            <Alert.Description>
              After you decide, your browser goes to <strong>
                {data.consent.redirectHost}
              </strong>, which receives the access you grant. A local
              application (Claude Code, an editor, the MCP inspector) returns to
              this computer instead. Deny this if you do not recognise the
              address.
            </Alert.Description>
          </Alert.Root>
        {/if}

        <form
          method="POST"
          action="?/approve&consent={encodeURIComponent(data.consent.id)}"
          class="grid gap-6"
          use:enhance={() => {
            pending = true;
            errors = {};
            return async ({ result }) => {
              pending = false;
              // No update(): the stored request is spent once answered, and
              // re-running the load would turn this page into an error.
              if (result.type === "success") {
                leave(result.data);
              } else if (result.type === "failure") {
                const failed = foldErrors(
                  (result.data?.errors ?? {}) as Record<string, string[]>,
                  KNOWN_FIELDS,
                );
                errors = Object.keys(failed).length
                  ? failed
                  : { form: ["Something went wrong. Please try again."] };
              } else {
                errors = { form: ["Something went wrong. Please try again."] };
              }
            };
          }}
        >
          <input type="hidden" name="consent" value={data.consent.id} />
          <FormAlert
            message={formError(errors) ?? formError(failure?.errors)}
          />
          <Field.Group>
            <p class="text-sm">
              {#if data.consent.askedForScopes}
                The application asked for the permissions ticked below.
              {:else}
                The application did not name permissions. Reading is ticked;
                nothing that changes data is.
              {/if}
              Tick or untick whatever you want it to have.
            </p>
            <AccessFields
              idPrefix={uid}
              scopeGroups={data.scopeGroups}
              scopeConflicts={data.scopeConflicts}
              categories={data.categories}
              accounts={data.accounts}
              {errors}
              expires={failure?.values?.expires ?? ""}
              bind:scopes
              bind:restrict
              bind:categoryIds
              bind:restrictAccounts
              bind:accountIds
              bind:granted
            />

            {#if writes.length > 0}
              <Alert.Root class="border-destructive/40">
                <TriangleAlertIcon />
                <Alert.Title>
                  This app will be able to change your data
                </Alert.Title>
                <Alert.Description>
                  An assistant with write permissions can change bills, matches,
                  categories and notes, and it can be misled by text inside your
                  payments. Every change it makes is recorded in the change log,
                  where you can revert it. Confirm it is you to grant this.
                </Alert.Description>
              </Alert.Root>
              <AdminConfirmFields
                idPrefix={uid}
                mode={data.confirmMode}
                {errors}
                description="Confirm it is you before allowing changes."
              />
            {/if}
          </Field.Group>

          <div class="flex flex-wrap justify-end gap-2">
            <Button
              type="submit"
              variant="outline"
              formaction="?/deny&consent={encodeURIComponent(data.consent.id)}"
              formnovalidate
              disabled={pending}
            >
              Deny
            </Button>
            <Button type="submit" disabled={pending}>
              {#if pending}<Spinner />Working…{:else}Allow{/if}
            </Button>
          </div>
        </form>
      {/if}
    </Card.Content>
  </Card.Root>
</main>
