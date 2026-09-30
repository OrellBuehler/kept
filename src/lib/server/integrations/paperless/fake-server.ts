/**
 * A small fake Paperless-ngx server for tests (local `Bun.serve`, port 0).
 * Nothing here talks to a real instance. Behaviour switches mimic the quirks
 * documented for Paperless-ngx 2.16+ / 3.x.
 */
export interface FakeDoc {
  id: number;
  /** ISO datetime */
  modified: string;
  mime_type: string;
  original_file_name: string | null;
  archived_file_name: string | null;
  tags: number[];
  custom_fields: Array<{ field: number; value: unknown }>;
  user_can_change: boolean;
  original?: Uint8Array;
  archive?: Uint8Array;
  /** Content type to answer downloads with (defaults to the mime type). */
  contentType?: string;
  /** Answer 404 for this many GETs of the document first (webhook before commit). */
  hiddenRequests?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  json?: unknown;
}

export interface FakeUpload {
  title: string | null;
  created: string | null;
  fileName: string;
  size: number;
}

export type TaskStep =
  "pending" | "success" | "failure" | "duplicate" | "missing";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FakePaperless {
  token = "test-token";
  serverVersion = "2.20.3";
  maxApiVersion = 10;
  accepted = [9, 10];
  /** Path prefix, like a reverse proxy sub-path ("" or "/paperless"). */
  prefix = "";
  docs = new Map<number, FakeDoc>();
  tags: Array<{ id: number; name: string }> = [];
  savedViews: Array<{
    id: number;
    name: string;
    filter_rules: Array<{ rule_type: number; value: string | null }>;
  }> = [];
  customFields: unknown[] = [];
  customFieldsStatus = 200;
  pageSize: number | null = null;
  wrongHostNext = false;
  redirectAll = false;
  delayMs = 0;
  bulkStatus = 200;
  taskShape: "v9" | "v10" = "v9";
  /** Each task poll consumes one step; the last step repeats. */
  taskSteps: TaskStep[] = ["success"];
  uploadStatus = 200;
  downloadStatus = 200;
  newDocumentId = 900;
  duplicateOf = 7;
  requests: RecordedRequest[] = [];
  uploads: FakeUpload[] = [];
  server!: ReturnType<typeof Bun.serve>;
  private polls = 0;

  start(): void {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handle(req),
    });
  }

  stop(): void {
    void this.server.stop(true);
  }

  get origin(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  get baseUrl(): string {
    return `${this.origin}${this.prefix}`;
  }

  addDoc(doc: Partial<FakeDoc> & { id: number }): FakeDoc {
    const full: FakeDoc = {
      modified: "2026-09-01T10:00:00+00:00",
      mime_type: "application/pdf",
      original_file_name: `doc-${doc.id}.pdf`,
      archived_file_name: `doc-${doc.id}-archive.pdf`,
      tags: [1],
      custom_fields: [],
      user_can_change: true,
      ...doc,
    };
    this.docs.set(full.id, full);
    return full;
  }

  requestsTo(pathPart: string, method?: string): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.path.includes(pathPart) && (!method || r.method === method),
    );
  }

  private json(
    body: unknown,
    init: ResponseInit = {},
    extra: HeadersInit = {},
  ) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    for (const [k, v] of new Headers(extra)) headers.set(k, v);
    return new Response(JSON.stringify(body), { ...init, headers });
  }

  private docJson(d: FakeDoc) {
    return {
      id: d.id,
      title: "Synthetic document",
      modified: d.modified,
      mime_type: d.mime_type,
      original_file_name: d.original_file_name,
      archived_file_name: d.archived_file_name,
      tags: d.tags,
      custom_fields: d.custom_fields,
      user_can_change: d.user_can_change,
    };
  }

  private page<T>(url: URL, items: T[]) {
    const size =
      this.pageSize ?? (Number(url.searchParams.get("page_size")) || 25);
    const page = Number(url.searchParams.get("page")) || 1;
    const slice = items.slice((page - 1) * size, page * size);
    let next: string | null = null;
    if (page * size < items.length) {
      const q = new URLSearchParams(url.searchParams);
      q.set("page", String(page + 1));
      const host = this.wrongHostNext
        ? "http://wrong-host.invalid"
        : this.origin;
      next = `${host}${url.pathname}?${q.toString()}`;
    }
    return { count: items.length, next, previous: null, results: slice };
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let json: unknown;
    if (
      req.method !== "GET" &&
      req.headers.get("content-type")?.includes("json")
    ) {
      json = await req.clone().json();
    }
    this.requests.push({
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      json,
    });
    if (this.delayMs) await sleep(this.delayMs);
    if (this.redirectAll) {
      return new Response(null, {
        status: 301,
        headers: { location: "https://elsewhere.invalid/" },
      });
    }
    if (!url.pathname.endsWith("/")) {
      return new Response(null, {
        status: 301,
        headers: { location: `${url.pathname}/${url.search}` },
      });
    }
    if (req.headers.get("authorization") !== `Token ${this.token}`) {
      return this.json({ detail: "Invalid token." }, { status: 401 });
    }
    const version = Number(
      /version=(\d+)/.exec(req.headers.get("accept") ?? "")?.[1],
    );
    const extra = {
      "X-Version": this.serverVersion,
      "X-Api-Version": String(this.maxApiVersion),
    };
    if (Number.isFinite(version) && !this.accepted.includes(version)) {
      return new Response(null, { status: 406, headers: extra });
    }
    const respond = (body: unknown, init: ResponseInit = {}) =>
      this.json(body, init, extra);

    let path = url.pathname;
    if (this.prefix && path.startsWith(this.prefix)) {
      path = path.slice(this.prefix.length);
    }
    const parts = path
      .replace(/^\/api\//, "")
      .replace(/\/$/, "")
      .split("/");
    const [root, second, third] = parts;

    if (root === "documents" && !second && req.method === "GET") {
      let list = [...this.docs.values()];
      const q = url.searchParams;
      const all = q.get("tags__id__all");
      if (all) {
        const need = all.split(",").map(Number);
        list = list.filter((d) => need.every((t) => d.tags.includes(t)));
      }
      const ids = q.get("id__in");
      if (ids) {
        const set = new Set(ids.split(",").map(Number));
        list = list.filter((d) => set.has(d.id));
      }
      const gt = q.get("modified__gt");
      if (gt)
        list = list.filter((d) => Date.parse(d.modified) > Date.parse(gt));
      if (q.get("ordering") === "modified") {
        list.sort((a, b) => Date.parse(a.modified) - Date.parse(b.modified));
      } else list.sort((a, b) => a.id - b.id);
      const p = this.page(
        url,
        list.map((d) => this.docJson(d)),
      );
      return respond(p);
    }
    if (
      root === "documents" &&
      second === "bulk_edit" &&
      req.method === "POST"
    ) {
      if (this.bulkStatus !== 200) {
        return respond({ error: "rejected" }, { status: this.bulkStatus });
      }
      const body = json as {
        documents: number[];
        parameters: { add_custom_fields: Record<string, unknown> };
      };
      for (const id of body.documents) {
        const doc = this.docs.get(id);
        if (!doc) continue;
        for (const [field, value] of Object.entries(
          body.parameters.add_custom_fields,
        )) {
          const existing = doc.custom_fields.find(
            (f) => f.field === Number(field),
          );
          if (existing) existing.value = value;
          else doc.custom_fields.push({ field: Number(field), value });
        }
        doc.modified = new Date(Date.parse(doc.modified) + 1000).toISOString();
      }
      return respond({ result: "OK" });
    }
    if (
      root === "documents" &&
      second === "post_document" &&
      req.method === "POST"
    ) {
      if (this.uploadStatus !== 200) {
        return respond({ error: "rejected" }, { status: this.uploadStatus });
      }
      const form = await req.formData();
      const file = form.get("document");
      this.uploads.push({
        title: (form.get("title") as string | null) ?? null,
        created: (form.get("created") as string | null) ?? null,
        fileName: file instanceof File ? file.name : "",
        size: file instanceof File ? file.size : 0,
      });
      this.polls = 0;
      return respond("b3f1c0de-0000-4000-8000-000000000001");
    }
    if (root === "documents" && second && /^\d+$/.test(second)) {
      const doc = this.docs.get(Number(second));
      if (!doc) return respond({ detail: "Not found." }, { status: 404 });
      if (!third && req.method === "GET") {
        if (doc.hiddenRequests && doc.hiddenRequests > 0) {
          doc.hiddenRequests--;
          return respond({ detail: "Not found." }, { status: 404 });
        }
        return respond(this.docJson(doc));
      }
      if (third === "download") {
        if (this.downloadStatus !== 200) {
          return new Response("upstream error page", {
            status: this.downloadStatus,
          });
        }
        const original = url.searchParams.get("original") === "true";
        const bytes = original ? doc.original : (doc.archive ?? doc.original);
        if (!bytes) return respond({ detail: "Not found." }, { status: 404 });
        return new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: {
            "content-type":
              doc.contentType ?? (original ? doc.mime_type : "application/pdf"),
            ...extra,
          },
        });
      }
    }
    if (root === "tags") {
      if (second) {
        const tag = this.tags.find((t) => t.id === Number(second));
        return tag
          ? respond(tag)
          : respond({ detail: "Not found." }, { status: 404 });
      }
      return respond(this.page(url, this.tags));
    }
    if (root === "saved_views") {
      if (second) {
        const view = this.savedViews.find((v) => v.id === Number(second));
        return view
          ? respond(view)
          : respond({ detail: "Not found." }, { status: 404 });
      }
      return respond(this.page(url, this.savedViews));
    }
    if (root === "custom_fields") {
      if (this.customFieldsStatus !== 200) {
        return respond(
          { detail: "forbidden" },
          { status: this.customFieldsStatus },
        );
      }
      return respond(this.page(url, this.customFields));
    }
    if (root === "tasks") {
      const step =
        this.taskSteps[Math.min(this.polls, this.taskSteps.length - 1)] ??
        "pending";
      this.polls++;
      return respond(this.taskBody(step));
    }
    return respond({ detail: "Not found." }, { status: 404 });
  }

  private taskBody(step: TaskStep) {
    if (step === "missing") {
      return this.taskShape === "v9"
        ? []
        : { count: 0, next: null, previous: null, results: [] };
    }
    const id = this.newDocumentId;
    if (this.taskShape === "v9") {
      const task =
        step === "pending"
          ? {
              task_id: "t",
              status: "PENDING",
              result: null,
              related_document: null,
            }
          : step === "success"
            ? {
                task_id: "t",
                status: "SUCCESS",
                result: `New document id ${id} created`,
                // 2.x reports this as a string, 3.x as a number.
                related_document: String(id),
              }
            : step === "duplicate"
              ? {
                  task_id: "t",
                  status: "FAILURE",
                  result: `file.pdf: Not consuming file.pdf: It is a duplicate of Other (#${this.duplicateOf})`,
                  related_document: null,
                }
              : {
                  task_id: "t",
                  status: "FAILURE",
                  result: "boom",
                  related_document: null,
                };
      return [task];
    }
    const task =
      step === "pending"
        ? {
            task_id: "t",
            status: "pending",
            related_document_ids: [],
            result_data: null,
          }
        : step === "success"
          ? {
              task_id: "t",
              status: "success",
              related_document_ids: [id],
              result_data: { document_id: id },
            }
          : step === "duplicate"
            ? {
                task_id: "t",
                status: "failure",
                related_document_ids: [],
                result_data: {
                  duplicate_of: this.duplicateOf,
                  reason: "duplicate",
                },
              }
            : {
                task_id: "t",
                status: "failure",
                related_document_ids: [],
                result_data: { error_message: "boom" },
              };
    return { count: 1, next: null, previous: null, results: [task] };
  }
}

/** Starts a fake server; call `.stop()` when done. */
export function startFakePaperless(): FakePaperless {
  const fake = new FakePaperless();
  fake.start();
  return fake;
}
