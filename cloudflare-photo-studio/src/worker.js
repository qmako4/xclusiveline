const BRAND = {
  name: "XCLUSIVELINE",
  yellow: "#F5A800",
  black: "#0A0A0A",
  white: "#FAFAFA",
  defaultBackgroundPath: "/xclusiveline-background.png",
  defaultBackgroundUrl: "https://qmako4.github.io/xclusiveline/assets/xclusiveline-studio-background.png",
};

const JSON_TYPE = "application/json; charset=utf-8";
const PNG_TYPE = "image/png";
const JPEG_TYPE = "image/jpeg";
const WEBP_TYPE = "image/webp";
const JOB_STALE_AFTER_MS = 2 * 60 * 1000;
const TERMINAL_JOB_STATUSES = ["complete", "partial", "failed", "cancelled"];

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      if (pathname === "/api/health") {
        return json({ ok: true, service: "xclusiveline-photo-studio", brand: BRAND.name }, request, env);
      }

      if (pathname === "/api/config" && request.method === "GET") {
        const imageModel = env.XCLUSIVELINE_OPENAI_IMAGE_MODEL || env.OPENAI_IMAGE_MODEL || "gpt-image-2";
        return json(
          {
            ok: true,
            brand: BRAND,
            imageModel,
            imageSize: outputSizeForModel(env, imageModel),
            keepCropImageSize: outputSizeForMode(env, imageModel, "keep-crop"),
            imageQuality: outputQualityForEnv(env),
            outputFormat: outputFormatForEnv(env),
            outputCompression: outputCompressionForEnv(env),
            maxBulkImages: maxBulkImages(env),
            yupooImportLimit: yupooImportLimit(env),
            requiresAdminToken: studioRequiresAdminToken(env),
            saveEnabled: Boolean(env.XCLUSIVELINE_MEDIA),
            publicMediaBaseUrl: env.XCLUSIVELINE_R2_PUBLIC_URL || null,
          },
          request,
          env,
        );
      }

      if (pathname === "/api/background" && request.method === "GET") {
        return await getDefaultBackground(request, env);
      }

      if (pathname === "/api/yupoo-images" && request.method === "POST") {
        await requireAdmin(request, env);
        return await importYupooImages(request, env);
      }

      if (pathname === "/api/yupoo-preview" && request.method === "GET") {
        return await getYupooPreview(request, env);
      }

      if (pathname === "/api/generate" && request.method === "POST") {
        await requireAdmin(request, env);
        return await generatePreviews(request, env);
      }

      if (pathname === "/api/jobs" && request.method === "POST") {
        await requireAdmin(request, env);
        return await createBackgroundJob(request, env, ctx);
      }

      if (pathname === "/api/jobs" && request.method === "GET") {
        await requireAdmin(request, env);
        return await getBackgroundJobs(request, env, ctx);
      }

      if (pathname === "/api/jobs/resume" && request.method === "POST") {
        await requireAdmin(request, env);
        return await resumeBackgroundJob(request, env, ctx);
      }

      if (pathname === "/api/jobs/cancel" && request.method === "POST") {
        await requireAdmin(request, env);
        return await cancelBackgroundJob(request, env);
      }

      if (pathname === "/api/save" && request.method === "POST") {
        await requireAdmin(request, env);
        return await saveGeneratedImages(request, env);
      }

      if (pathname === "/api/media" && request.method === "GET") {
        await requireAdmin(request, env);
        return await listMedia(request, env);
      }

      if (pathname === "/api/media" && request.method === "DELETE") {
        await requireAdmin(request, env);
        return await deleteMediaObject(request, env);
      }

      if (pathname === "/api/media/raw" && request.method === "GET") {
        await requireAdmin(request, env);
        return await getMediaObject(request, env);
      }

      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return json({ ok: false, error: "Not found" }, request, env, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || "Request failed" }, request, env, error.status || 500);
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages || []) {
      await processBackgroundJobMessage(env, message.body);
      if (typeof message.ack === "function") {
        message.ack();
      }
    }
  },
};

async function importYupooImages(request, env) {
  const body = await request.json().catch(() => ({}));
  const sourceUrl = parseYupooPageUrl(body.url);
  const limit = yupooImportLimit(env, body.limit);
  const candidates = [];
  const visitedPages = new Set();
  let pagesScanned = 0;

  if (isLikelyYupooProductImageUrl(sourceUrl)) {
    candidates.push({ url: sourceUrl.toString(), pageUrl: sourceUrl.toString(), score: 120, order: 0 });
  } else {
    const firstHtml = await fetchYupooHtml(sourceUrl);
    pagesScanned += 1;
    visitedPages.add(sourceUrl.toString());
    candidates.push(...extractYupooImageCandidates(firstHtml, sourceUrl));

    const isAlbumPage = /\/albums\/\d+/i.test(sourceUrl.pathname);
    const albumLinks = isAlbumPage ? [] : extractYupooAlbumLinks(firstHtml, sourceUrl);
    for (const albumUrl of albumLinks.slice(0, 12)) {
      if (visitedPages.has(albumUrl)) continue;
      if (chooseBestYupooImages(candidates).length >= limit) break;
      try {
        const html = await fetchYupooHtml(new URL(albumUrl));
        visitedPages.add(albumUrl);
        pagesScanned += 1;
        candidates.push(...extractYupooImageCandidates(html, new URL(albumUrl)));
      } catch {
        // Some Yupoo albums block scraping or require a password; keep any images already found.
      }
    }
  }

  const allImages = chooseBestYupooImages(candidates);
  if (!allImages.length) {
    throw statusError("No Yupoo product images were found on that link.", 404);
  }

  const selected = allImages.slice(0, limit);
  const images = selected.map((candidate, index) => {
    const contentType = contentTypeFromImageUrl(candidate.url) || "image/jpeg";
    return {
      url: candidate.url,
      previewUrl: candidate.url,
      pageUrl: candidate.pageUrl || sourceUrl.toString(),
      filename: yupooFilename(candidate.url, index + 1, contentType),
      contentType,
    };
  });

  return json(
    {
      ok: true,
      sourceUrl: sourceUrl.toString(),
      images,
      totalFound: allImages.length,
      imported: images.length,
      failed: 0,
      truncated: allImages.length > selected.length,
      limit,
      pagesScanned,
      errors: [],
    },
    request,
    env,
  );
}

async function getYupooPreview(request, env) {
  const requestUrl = new URL(request.url);
  const imageUrl = parseYupooImageUrl(requestUrl.searchParams.get("url"));
  const referer = yupooReferer(requestUrl.searchParams.get("pageUrl"), imageUrl);
  const response = await fetch(imageUrl.toString(), {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      referer,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw statusError(`Yupoo preview could not be loaded (${response.status}).`, 502);
  }

  const fallbackType = contentTypeFromImageUrl(imageUrl.toString()) || "image/jpeg";
  const contentType = normalizeImageContentType(response.headers.get("content-type")) || fallbackType;
  if (!contentType.startsWith("image/")) {
    throw statusError("Yupoo returned a non-image preview response.", 502);
  }

  const buffer = await response.arrayBuffer();
  const maxMb = 20;
  if (buffer.byteLength > maxMb * 1024 * 1024) {
    throw statusError("Yupoo preview image is larger than 20MB.", 400);
  }

  return new Response(buffer, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=3600",
      ...corsHeaders(request, env),
    },
  });
}

async function generatePreviews(request, env) {
  const form = await request.formData();
  const uploadedFiles = form
    .getAll("products")
    .filter((file) => file && typeof file === "object" && file.size > 0);
  const productUrlItems = parseProductUrlItems(form.get("productUrls"));
  const productFiles = [...uploadedFiles];
  const generationMode = normalizeGenerationMode(form.get("mode"));
  const productModes = parseProductModes(form.get("productModes"), uploadedFiles.length + productUrlItems.length, generationMode);

  if (!uploadedFiles.length && !productUrlItems.length) {
    throw statusError("Upload at least one product image.", 400);
  }

  if (uploadedFiles.length + productUrlItems.length > maxBulkImages(env)) {
    throw statusError(`Upload ${maxBulkImages(env)} images or fewer per batch.`, 400);
  }

  for (const item of productUrlItems) {
    productFiles.push(await fetchRemoteProductFile(item));
  }

  const submittedBackground = form.get("background");
  const backgroundFile =
    submittedBackground && typeof submittedBackground === "object" && submittedBackground.size > 0
      ? submittedBackground
      : await loadDefaultBackgroundFile(request, env);
  const normalizedBackgroundFile = await normalizeImageFileForOpenAi(backgroundFile, "XCLUSIVELINE background");

  const results = [];
  const errors = [];

  for (let index = 0; index < productFiles.length; index += 1) {
    let productFile = productFiles[index];
    try {
      productFile = await normalizeImageFileForOpenAi(productFile, `Product ${index + 1}`);
      const generated = await generateFlatlayComposite({
        env,
        productFile,
        backgroundFile: normalizedBackgroundFile,
        generationMode: productModes[index] || generationMode,
      });

      const id = crypto.randomUUID();
      const filename = outputFilename(productFile.name, id, generated.contentType);
      results.push({
        id,
        sourceIndex: index,
        originalName: productFile.name || `product-${index + 1}`,
        filename,
        contentType: generated.contentType,
        b64: generated.b64,
        dataUrl: `data:${generated.contentType};base64,${generated.b64}`,
        mode: generated.mode,
        prompt: generated.prompt,
        imageSize: generated.imageSize,
        saved: false,
      });
    } catch (error) {
      errors.push({
        originalName: productFile.name || `product-${index + 1}`,
        error: error.message || "Generation failed.",
      });
    }
  }

  return json({ ok: true, results, errors }, request, env);
}

async function createBackgroundJob(request, env, ctx) {
  if (!env.XCLUSIVELINE_MEDIA) {
    throw statusError("XCLUSIVELINE_MEDIA R2 binding is not configured.", 500);
  }

  const form = await request.formData();
  const uploadedFiles = form
    .getAll("products")
    .filter((file) => file && typeof file === "object" && file.size > 0);
  const productUrlItems = parseProductUrlItems(form.get("productUrls"));
  const total = uploadedFiles.length + productUrlItems.length;
  if (!total) {
    throw statusError("Upload at least one product image.", 400);
  }
  if (total > maxBulkImages(env)) {
    throw statusError(`Upload ${maxBulkImages(env)} images or fewer per batch.`, 400);
  }

  const jobId = crypto.randomUUID();
  const mode = normalizeGenerationMode(form.get("mode"));
  const productModes = parseProductModes(form.get("productModes"), total, mode);
  const prefix = cleanPrefix(env.XCLUSIVELINE_R2_PREFIX || "photo-studio/");
  const jobPrefixValue = jobPrefix(env, jobId);
  const now = new Date().toISOString();
  const items = [];

  let itemIndex = 0;
  for (const file of uploadedFiles) {
    const normalizedFile = await normalizeImageFileForOpenAi(file, `Product ${itemIndex + 1}`);
    const contentType = normalizedFile.type;
    const filename = safeFilename(normalizedFile.name || `product-${itemIndex + 1}.${extensionForContentType(contentType)}`);
    const sourceKey = `${jobPrefixValue}sources/${String(itemIndex + 1).padStart(2, "0")}-${crypto.randomUUID()}-${filename}`;
    const bytes = await normalizedFile.arrayBuffer();
    await env.XCLUSIVELINE_MEDIA.put(sourceKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { brand: BRAND.name, role: "job-source", originalName: filename },
    });
    items.push({
      id: crypto.randomUUID(),
      status: "queued",
      mode: productModes[itemIndex] || mode,
      originalName: filename,
      sourceKey,
      contentType,
      size: bytes.byteLength,
    });
    itemIndex += 1;
  }

  for (const item of productUrlItems) {
    items.push({
      id: crypto.randomUUID(),
      status: "queued",
      mode: productModes[itemIndex] || mode,
      originalName: item.filename || `remote-product-${itemIndex + 1}.jpg`,
      remote: item,
    });
    itemIndex += 1;
  }

  let background = { kind: "default" };
  const submittedBackground = form.get("background");
  if (submittedBackground && typeof submittedBackground === "object" && submittedBackground.size > 0) {
    const normalizedBackground = await normalizeImageFileForOpenAi(submittedBackground, "XCLUSIVELINE background");
    const contentType = normalizedBackground.type;
    const filename = safeFilename(normalizedBackground.name || `background.${extensionForContentType(contentType)}`);
    const backgroundKey = `${jobPrefixValue}background/${crypto.randomUUID()}-${filename}`;
    const bytes = await normalizedBackground.arrayBuffer();
    await env.XCLUSIVELINE_MEDIA.put(backgroundKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { brand: BRAND.name, role: "job-background", originalName: filename },
    });
    background = { kind: "stored", key: backgroundKey, filename, contentType };
  }

  const job = {
    id: jobId,
    status: "queued",
    mode,
    prefix,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    total: items.length,
    completed: 0,
    failed: 0,
    background,
    items,
  };

  await writeJob(env, job);
  const enqueueResult = await enqueueBackgroundJob(env, job, ctx);
  const queuedJob = await readJob(env, jobId);
  return json({ ok: true, job: publicJob(queuedJob || job), queue: enqueueResult }, request, env, 202);
}

async function getBackgroundJobs(request, env, ctx) {
  if (!env.XCLUSIVELINE_MEDIA) {
    throw statusError("XCLUSIVELINE_MEDIA R2 binding is not configured.", 500);
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (id) {
    let job = await readJob(env, id);
    if (!job) throw statusError("Background job was not found.", 404);
    if (isStaleJob(job)) {
      job = await resumeJobInPlace(env, job, ctx, "stale-read-recovery");
    }
    return json({ ok: true, job: publicJob(job) }, request, env);
  }

  const prefix = `${cleanPrefix(env.XCLUSIVELINE_R2_PREFIX || "photo-studio/")}jobs/`;
  const limit = Math.min(Number(url.searchParams.get("limit") || 12), 30);
  const listed = await env.XCLUSIVELINE_MEDIA.list({ prefix, limit: 100 });
  const jobKeys = listed.objects
    .map((object) => object.key)
    .filter((key) => key.endsWith("/job.json"))
    .slice(0, limit);
  const jobs = [];
  for (const key of jobKeys) {
    const object = await env.XCLUSIVELINE_MEDIA.get(key);
    if (!object) continue;
    const job = await object.json();
    jobs.push(publicJob(job, { includeItems: false }));
  }
  jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return json({ ok: true, jobs, truncated: listed.truncated, cursor: listed.cursor || null }, request, env);
}

async function resumeBackgroundJob(request, env, ctx) {
  if (!env.XCLUSIVELINE_MEDIA) {
    throw statusError("XCLUSIVELINE_MEDIA R2 binding is not configured.", 500);
  }

  const body = await request.json().catch(() => ({}));
  const id = body.id || new URL(request.url).searchParams.get("id");
  if (!id) throw statusError("Missing background job id.", 400);
  let job = await readJob(env, id);
  if (!job) throw statusError("Background job was not found.", 404);
  if (isTerminalJobStatus(job.status)) {
    return json({ ok: true, job: publicJob(job), alreadyFinished: true }, request, env);
  }
  job = await resumeJobInPlace(env, job, ctx, "manual-resume");
  return json({ ok: true, job: publicJob(job) }, request, env, 202);
}

async function cancelBackgroundJob(request, env) {
  if (!env.XCLUSIVELINE_MEDIA) {
    throw statusError("XCLUSIVELINE_MEDIA R2 binding is not configured.", 500);
  }

  const body = await request.json().catch(() => ({}));
  const id = body.id || new URL(request.url).searchParams.get("id");
  if (!id) throw statusError("Missing background job id.", 400);

  const job = await readJob(env, id);
  if (!job) throw statusError("Background job was not found.", 404);
  if (isTerminalJobStatus(job.status)) {
    return json({ ok: true, job: publicJob(job), alreadyFinished: true }, request, env);
  }

  const now = new Date().toISOString();
  for (const item of job.items || []) {
    if (["queued", "running"].includes(item.status)) {
      item.status = "cancelled";
      item.error = null;
      item.cancelledAt = now;
    }
  }

  job.status = "cancelled";
  job.cancelledAt = now;
  job.finishedAt = now;
  job.completed = (job.items || []).filter((entry) => entry.status === "complete").length;
  job.failed = (job.items || []).filter((entry) => entry.status === "failed").length;
  job.cancelled = (job.items || []).filter((entry) => entry.status === "cancelled").length;
  await writeJob(env, job);

  return json({ ok: true, job: publicJob(job) }, request, env);
}

async function enqueueBackgroundJob(env, job, ctx, reason = "created") {
  if (job.status === "cancelled") {
    return { method: "none", count: 0 };
  }

  const pending = (job.items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.status === "queued");

  if (!pending.length) {
    await finalizeJobProgress(env, job);
    return { method: "none", count: 0 };
  }

  job.status = job.startedAt ? "running" : "queued";
  job.finishedAt = null;
  job.queue = {
    method: env.XCLUSIVELINE_STUDIO_QUEUE ? "queue" : "waitUntil",
    reason,
    count: pending.length,
    enqueuedAt: new Date().toISOString(),
  };
  await writeJob(env, job);

  if (env.XCLUSIVELINE_STUDIO_QUEUE && typeof env.XCLUSIVELINE_STUDIO_QUEUE.sendBatch === "function") {
    const messages = pending.map(({ item, index }) => ({
      body: {
        type: "xclusiveline-photo-studio-item",
        jobId: job.id,
        itemId: item.id,
        index,
      },
    }));

    for (let index = 0; index < messages.length; index += 100) {
      await env.XCLUSIVELINE_STUDIO_QUEUE.sendBatch(messages.slice(index, index + 100));
    }

    return { method: "queue", count: messages.length };
  }

  if (ctx) {
    ctx.waitUntil(processBackgroundJob(env, job.id));
    return { method: "waitUntil", count: pending.length };
  }

  throw statusError("Background queue binding is not configured.", 500);
}

async function resumeJobInPlace(env, job, ctx, reason) {
  for (const item of job.items || []) {
    if (item.status === "running") {
      item.status = "queued";
      item.error = null;
      item.resumedAt = new Date().toISOString();
    }
  }

  job.completed = (job.items || []).filter((entry) => entry.status === "complete").length;
  job.failed = (job.items || []).filter((entry) => entry.status === "failed").length;
  job.status = job.completed + job.failed >= (job.total || 0) ? job.status : "queued";
  job.finishedAt = null;
  await writeJob(env, job);
  await enqueueBackgroundJob(env, job, ctx, reason);
  return (await readJob(env, job.id)) || job;
}

function isStaleJob(job) {
  if (!job || isTerminalJobStatus(job.status)) return false;
  if (job.queue?.method === "queue") return false;
  const updatedAt = Date.parse(job.updatedAt || job.startedAt || job.createdAt || "");
  if (!Number.isFinite(updatedAt)) return false;
  const incomplete = (job.completed || 0) + (job.failed || 0) < (job.total || job.items?.length || 0);
  return incomplete && Date.now() - updatedAt > JOB_STALE_AFTER_MS;
}

function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.includes(String(status || ""));
}

async function processBackgroundJob(env, jobId) {
  let job = await readJob(env, jobId);
  if (!job || isTerminalJobStatus(job.status)) return;

  for (let index = 0; index < job.items.length; index += 1) {
    job = await readJob(env, jobId);
    if (!job || isTerminalJobStatus(job.status)) return;
    const item = job.items[index];
    if (!item || ["complete", "failed", "cancelled"].includes(item.status)) continue;
    await processBackgroundJobItem(env, jobId, item.id, index);
  }
}

async function processBackgroundJobMessage(env, rawBody) {
  const body = normalizeQueueMessageBody(rawBody);
  if (!body?.jobId) return;
  await processBackgroundJobItem(env, body.jobId, body.itemId, Number(body.index));
}

function normalizeQueueMessageBody(value) {
  if (typeof value !== "string") return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function processBackgroundJobItem(env, jobId, itemId, fallbackIndex = 0) {
  let job = await readJob(env, jobId);
  if (!job || isTerminalJobStatus(job.status)) return;

  const indexById = (job.items || []).findIndex((entry) => entry.id === itemId);
  const index = indexById >= 0 ? indexById : fallbackIndex;
  const item = job.items?.[index];
  if (!item || item.status === "complete" || item.status === "failed" || item.status === "cancelled") {
    await finalizeJobProgress(env, job);
    return;
  }

  item.status = "running";
  item.startedAt = item.startedAt || new Date().toISOString();
  item.lastAttemptAt = new Date().toISOString();
  item.error = null;
  job.status = "running";
  job.startedAt = job.startedAt || new Date().toISOString();
  job.finishedAt = null;
  await writeJob(env, job);

  try {
    let productFile = item.remote ? await fetchRemoteProductFile(item.remote) : await fileFromR2(env, item.sourceKey, item.originalName);
    productFile = await normalizeImageFileForOpenAi(productFile, `Product ${index + 1}`);
    const backgroundFile = await backgroundFileForJob(env, job);
    const generated = await generateFlatlayComposite({
      env,
      productFile,
      backgroundFile,
      generationMode: item.mode || job.mode,
    });
    const latestJob = await readJob(env, jobId);
    const latestItem = latestJob?.items?.find((entry) => entry.id === item.id);
    if (latestJob?.status === "cancelled" || latestItem?.status === "cancelled") {
      return;
    }
    const id = crypto.randomUUID();
    const filename = outputFilename(productFile.name || item.originalName, id, generated.contentType);
    const bytes = base64ToUint8Array(generated.b64);
    const key = `${jobPrefix(env, jobId)}outputs/${String(index + 1).padStart(2, "0")}-${id}-${filename}`;
    await env.XCLUSIVELINE_MEDIA.put(key, bytes, {
      httpMetadata: {
        contentType: generated.contentType,
        cacheControl: "private, max-age=604800",
      },
      customMetadata: {
        brand: BRAND.name,
        source: item.originalName || "",
        createdBy: "xclusiveline-photo-studio-job",
      },
    });
    const storedJob = await readJob(env, jobId);
    const storedItem = storedJob?.items?.find((entry) => entry.id === item.id);
    if (storedJob?.status === "cancelled" || storedItem?.status === "cancelled") {
      return;
    }

    item.status = "complete";
    item.finishedAt = new Date().toISOString();
    item.result = {
      id,
      key,
      filename,
      originalName: item.originalName || productFile.name || `product-${index + 1}`,
      contentType: generated.contentType,
      size: bytes.byteLength,
      rawUrl: `/api/media/raw?key=${encodeURIComponent(key)}`,
      mode: generated.mode,
      prompt: generated.prompt,
      imageSize: generated.imageSize,
      saved: false,
    };
  } catch (error) {
    item.status = "failed";
    item.finishedAt = new Date().toISOString();
    item.error = error.message || "Generation failed.";
  }

  const latestBeforeFinalize = await readJob(env, jobId);
  if (latestBeforeFinalize?.status === "cancelled") return;
  await finalizeJobProgress(env, job);
}

async function finalizeJobProgress(env, job) {
  job.completed = job.items.filter((entry) => entry.status === "complete").length;
  job.failed = job.items.filter((entry) => entry.status === "failed").length;
  job.cancelled = job.items.filter((entry) => entry.status === "cancelled").length;
  const total = job.total || job.items.length || 0;
  if (job.status === "cancelled") {
    job.finishedAt = job.finishedAt || new Date().toISOString();
  } else if (job.completed + job.failed + job.cancelled >= total) {
    if (job.cancelled && !job.completed && !job.failed) {
      job.status = "cancelled";
    } else if (job.cancelled) {
      job.status = job.completed > 0 ? "partial" : "failed";
    } else {
      job.status = job.completed === total ? "complete" : job.completed > 0 ? "partial" : "failed";
    }
    job.finishedAt = new Date().toISOString();
  } else {
    job.status = "running";
    job.finishedAt = null;
  }
  await writeJob(env, job);
}

async function fileFromR2(env, key, fallbackName) {
  const object = await env.XCLUSIVELINE_MEDIA.get(key);
  if (!object) {
    throw statusError("Stored job source image was not found.", 404);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = headers.get("content-type") || "image/jpeg";
  const bytes = await object.arrayBuffer();
  const filename = fallbackName || key.split("/").pop() || `image.${extensionForContentType(contentType)}`;
  if (typeof File === "function") {
    return new File([bytes], filename, { type: contentType });
  }
  const blob = new Blob([bytes], { type: contentType });
  blob.name = filename;
  return blob;
}

async function backgroundFileForJob(env, job) {
  if (job.background?.kind === "stored" && job.background.key) {
    return await normalizeImageFileForOpenAi(await fileFromR2(env, job.background.key, job.background.filename), "XCLUSIVELINE background");
  }
  return await loadDefaultBackgroundFileFromUrl(env);
}

async function loadDefaultBackgroundFileFromUrl(env) {
  const response = await fetch(env.XCLUSIVELINE_BACKGROUND_URL || BRAND.defaultBackgroundUrl);
  if (!response.ok) {
    throw statusError("Default XCLUSIVELINE background asset was not found.", 500);
  }
  const contentType = response.headers.get("content-type") || "image/png";
  return new Blob([await response.arrayBuffer()], { type: contentType });
}

function jobPrefix(env, jobId) {
  return `${cleanPrefix(env.XCLUSIVELINE_R2_PREFIX || "photo-studio/")}jobs/${jobId}/`;
}

function jobRecordKey(env, jobId) {
  return `${jobPrefix(env, jobId)}job.json`;
}

function isJobOutputKey(env, key) {
  const jobsPrefix = `${cleanPrefix(env.XCLUSIVELINE_R2_PREFIX || "photo-studio/")}jobs/`;
  return String(key || "").startsWith(jobsPrefix) && String(key || "").includes("/outputs/");
}

function jobIdFromOutputKey(env, key) {
  const jobsPrefix = `${cleanPrefix(env.XCLUSIVELINE_R2_PREFIX || "photo-studio/")}jobs/`;
  const text = String(key || "");
  if (!text.startsWith(jobsPrefix)) return "";
  const parts = text.slice(jobsPrefix.length).split("/");
  return parts[1] === "outputs" ? parts[0] : "";
}

async function readJob(env, jobId) {
  const object = await env.XCLUSIVELINE_MEDIA.get(jobRecordKey(env, jobId));
  if (!object) return null;
  return await object.json();
}

async function writeJob(env, job) {
  const record = { ...job, updatedAt: new Date().toISOString() };
  await env.XCLUSIVELINE_MEDIA.put(jobRecordKey(env, job.id), JSON.stringify(record, null, 2), {
    httpMetadata: {
      contentType: JSON_TYPE,
      cacheControl: "private, max-age=0, no-store",
    },
    customMetadata: {
      brand: BRAND.name,
      createdBy: "xclusiveline-photo-studio-job",
    },
  });
  return record;
}

async function markJobOutputDeleted(env, key) {
  const jobId = jobIdFromOutputKey(env, key);
  if (!jobId) return;
  const job = await readJob(env, jobId);
  if (!job) return;
  const item = (job.items || []).find((entry) => entry.result?.key === key);
  if (!item?.result) return;
  item.result.deleted = true;
  item.result.deletedAt = new Date().toISOString();
  await writeJob(env, job);
}

function publicJob(job, options = {}) {
  const includeItems = options.includeItems !== false;
  const publicValue = {
    id: job.id,
    status: job.status,
    mode: job.mode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    total: job.total || job.items?.length || 0,
    completed: job.completed || 0,
    failed: job.failed || 0,
    cancelled: job.cancelled || 0,
  };
  if (includeItems) {
    publicValue.items = (job.items || []).map((item, index) => ({
      id: item.id,
      status: item.status,
      mode: item.mode || job.mode,
      originalName: item.originalName || `product-${index + 1}`,
      error: item.error || null,
      result: item.result || null,
    }));
  }
  return publicValue;
}

async function saveGeneratedImages(request, env) {
  if (!env.XCLUSIVELINE_MEDIA) {
    throw statusError("XCLUSIVELINE_MEDIA R2 binding is not configured.", 500);
  }

  const body = await request.json();
  const images = Array.isArray(body.images) ? body.images : body.image ? [body.image] : [];

  if (!images.length) {
    throw statusError("No generated images were supplied to save.", 400);
  }

  const saved = [];
  const prefix = cleanPrefix(env.XCLUSIVELINE_R2_PREFIX || "photo-studio/");
  const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, "/");

  for (const image of images) {
    let contentType = image.contentType || PNG_TYPE;
    let bytes;
    if (image.key) {
      const sourceKey = String(image.key);
      if (!isJobOutputKey(env, sourceKey)) {
        throw statusError("Saved image key is outside the generated job output library.", 400);
      }
      const object = await env.XCLUSIVELINE_MEDIA.get(sourceKey);
      if (!object) {
        throw statusError("Generated job image was not found.", 404);
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      contentType = image.contentType || headers.get("content-type") || PNG_TYPE;
      bytes = new Uint8Array(await object.arrayBuffer());
    } else {
      const b64 = stripDataUrl(image.b64 || image.dataUrl || "");
      if (!b64) {
        throw statusError("Saved image is missing base64 content.", 400);
      }
      bytes = base64ToUint8Array(b64);
    }

    const key = `${prefix}generated/${datePath}/${crypto.randomUUID()}-${safeFilename(image.filename || "xclusiveline-output.png")}`;

    await env.XCLUSIVELINE_MEDIA.put(key, bytes, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        brand: BRAND.name,
        source: image.originalName || "",
        createdBy: "xclusiveline-photo-studio",
      },
    });

    saved.push({
      key,
      filename: image.filename || key.split("/").pop(),
      contentType,
      size: bytes.byteLength,
      publicUrl: mediaPublicUrl(env, key),
      rawUrl: `/api/media/raw?key=${encodeURIComponent(key)}`,
    });
  }

  return json({ ok: true, saved }, request, env);
}

async function listMedia(request, env) {
  if (!env.XCLUSIVELINE_MEDIA) {
    throw statusError("XCLUSIVELINE_MEDIA R2 binding is not configured.", 500);
  }

  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") || `${cleanPrefix(env.XCLUSIVELINE_R2_PREFIX || "photo-studio/")}generated/`;
  const limit = Math.min(Number(url.searchParams.get("limit") || 60), 100);
  const listed = await env.XCLUSIVELINE_MEDIA.list({ prefix, limit });

  return json(
    {
      ok: true,
      objects: listed.objects.map((object) => ({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded,
        publicUrl: mediaPublicUrl(env, object.key),
        rawUrl: `/api/media/raw?key=${encodeURIComponent(object.key)}`,
      })),
      truncated: listed.truncated,
      cursor: listed.cursor || null,
    },
    request,
    env,
  );
}

async function getMediaObject(request, env) {
  if (!env.XCLUSIVELINE_MEDIA) {
    throw statusError("XCLUSIVELINE_MEDIA R2 binding is not configured.", 500);
  }

  const key = new URL(request.url).searchParams.get("key");
  if (!key) {
    throw statusError("Missing media key.", 400);
  }

  const object = await env.XCLUSIVELINE_MEDIA.get(key);
  if (!object) {
    throw statusError("Media object not found.", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", headers.get("cache-control") || "private, max-age=60");
  return new Response(object.body, { headers });
}

async function deleteMediaObject(request, env) {
  if (!env.XCLUSIVELINE_MEDIA) {
    throw statusError("XCLUSIVELINE_MEDIA R2 binding is not configured.", 500);
  }

  const url = new URL(request.url);
  let key = url.searchParams.get("key");
  if (!key && (request.headers.get("content-type") || "").includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    key = body.key;
  }

  if (!key) {
    throw statusError("Missing media key.", 400);
  }

  const allowedPrefix = `${cleanPrefix(env.XCLUSIVELINE_R2_PREFIX || "photo-studio/")}generated/`;
  const isGeneratedImage = key.startsWith(allowedPrefix);
  const isJobImage = isJobOutputKey(env, key);
  if (!isGeneratedImage && !isJobImage) {
    throw statusError("Media key is outside the generated image library.", 400);
  }

  await env.XCLUSIVELINE_MEDIA.delete(key);
  if (isJobImage) {
    await markJobOutputDeleted(env, key);
  }
  return json({ ok: true, deleted: { key } }, request, env);
}

async function generateFlatlayComposite({ env, productFile, backgroundFile, generationMode }) {
  const apiKey = env.OPENAI_API_KEY || env.XCLUSIVELINE_OPENAI_API_KEY;
  if (!apiKey) {
    throw statusError("Missing OPENAI_API_KEY or XCLUSIVELINE_OPENAI_API_KEY.", 500);
  }

  const mode = normalizeGenerationMode(generationMode);
  const prompt = buildGenerationPrompt(productFile.name, mode);
  const model = env.XCLUSIVELINE_OPENAI_IMAGE_MODEL || env.OPENAI_IMAGE_MODEL || "gpt-image-2";
  const size = outputSizeForMode(env, model, mode);
  const quality = outputQualityForEnv(env);
  const outputFormat = outputFormatForEnv(env);
  const outputContentType = contentTypeForOutputFormat(outputFormat);
  const outputCompression = outputCompressionForEnv(env);
  const firstAttempt = await callOpenAiImagesEdit({
    apiKey,
    model,
    size,
    quality,
    outputFormat,
    outputContentType,
    outputCompression,
    prompt,
    productFile,
    backgroundFile,
    imageField: "image[]",
  });

  let finalAttempt = firstAttempt;
  if (!firstAttempt.ok && shouldRetryWithRepeatedImageField(firstAttempt.errorText)) {
    finalAttempt = await callOpenAiImagesEdit({
      apiKey,
      model,
      size,
      quality,
      outputFormat,
      outputContentType,
      outputCompression,
      prompt,
      productFile,
      backgroundFile,
      imageField: "image",
    });
  }

  if (!finalAttempt.ok) {
    throw statusError(`OpenAI image edit failed: ${finalAttempt.errorText}`, 502);
  }

  return { ...finalAttempt.image, prompt, imageSize: size, mode };
}

async function callOpenAiImagesEdit({
  apiKey,
  model,
  size,
  quality,
  outputFormat,
  outputContentType,
  outputCompression,
  prompt,
  productFile,
  backgroundFile,
  imageField,
}) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("background", "opaque");
  form.append("output_format", outputFormat);
  form.append("quality", quality);
  if (outputFormat !== "png") {
    form.append("output_compression", String(outputCompression));
  }
  form.append(imageField, productFile, productFile.name || "product.png");
  form.append(imageField, backgroundFile, backgroundFile.name || "xclusiveline-background.png");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const responseText = await response.text();
  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      errorText: payload?.error?.message || responseText || `${response.status} ${response.statusText}`,
    };
  }

  const first = payload?.data?.[0];
  if (first?.b64_json) {
    return {
      ok: true,
      image: {
        b64: first.b64_json,
        contentType: outputContentType,
      },
    };
  }

  if (first?.url) {
    const imageResponse = await fetch(first.url);
    if (!imageResponse.ok) {
      return { ok: false, errorText: `Generated image URL download failed: ${imageResponse.status}` };
    }
    const contentType = imageResponse.headers.get("content-type") || PNG_TYPE;
    return {
      ok: true,
      image: {
        b64: arrayBufferToBase64(await imageResponse.arrayBuffer()),
        contentType,
      },
    };
  }

  return { ok: false, errorText: "OpenAI response did not include b64_json or url." };
}

function buildGenerationPrompt(productName, mode) {
  if (mode === "keep-crop") return buildKeepCropPrompt(productName);
  if (mode === "auto") return buildAutoPrompt(productName);
  return buildFlatlayPrompt(productName);
}

function buildAutoPrompt(productName) {
  return [
    "Use case: Smart Auto XCLUSIVELINE product photo background replacement.",
    `Input image 1 is the product photo${productName ? ` named ${productName}` : ""}. Input image 2 is the original XCLUSIVELINE yellow fabric background.`,
    "Make an internal decision first. Do not write the decision, labels, notes, or text into the image.",
    "Decision rule: choose BACKGROUND-ONLY KEEP-CROP unless the image clearly qualifies for FULL-PRODUCT FLAT-LAY. When uncertain, keep-crop is always the correct choice.",
    "Choose BACKGROUND-ONLY KEEP-CROP when any of these are true: the product is cropped by any frame edge; only part of the item is visible; the item is a close-up/detail shot; the product touches or nearly touches the image edge; the product already fills most of the canvas; the photo shows multiple products, grouped products, overlapping items, or a set/bundle arrangement; the photo is mainly correct but has a plain grey/white/table/floor background; perspective is not a clean overhead full-item view; or confidence is not high.",
    "For BACKGROUND-ONLY KEEP-CROP: keep the exact uploaded canvas/crop, product position, visible scale, perspective, rotation, and composition. Do not zoom out, zoom in, center, shrink, enlarge, rotate, straighten, re-angle, complete missing parts, extend canvas, or create a new full product image. Replace only visible non-product background pixels with yellow XCLUSIVELINE fabric texture.",
    "Choose FULL-PRODUCT FLAT-LAY only when all of these are true: one complete product or one complete existing group is visible; all important edges are inside the frame; the product has enough separation from the existing background; the product can be naturally isolated without inventing missing parts; the camera angle can plausibly become an overhead ecommerce flat-lay; and there is room to show yellow fabric around it.",
    "For FULL-PRODUCT FLAT-LAY: create a realistic 3:4 overhead ecommerce flat-lay on the supplied yellow fabric background. Keep product scale believable, usually filling about 50-68% of the canvas for clothing and less for shoes/accessories. Leave natural yellow fabric visible around the item and do not make it touch the output edges.",
    "In both decisions, preserve the product exactly: shape, silhouette, colour, logos, printed text, texture, stitching, fabric grain, mesh holes, tags, defects, marks, wear, shadows on the product, hands, clothing, shoes, watches, and edge detail.",
    "Preserve the exact number of product items. Do not add duplicates, extra colourways, extra garments, extra logos, missing alternate items, or a new product arrangement. If the input has one item, output one item. If it has a group, keep the same group and overlap order.",
    "Do not smooth, repaint, recolour, relight, retouch, redesign, restyle, de-wrinkle, clean, repair, upscale, or alter the product. Avoid AI smoothing and keep the product texture real.",
    "Use the supplied XCLUSIVELINE background as the physical surface. Preserve its yellow fabric texture and any existing black lettering only where it naturally appears from the supplied background. Do not invent, duplicate, extend, or add extra XCLUSIVELINE text, bottom text, logos, watermarks, labels, props, hangers, hands, floors, or walls.",
    "Only add subtle contact realism where the product meets the yellow fabric: a soft natural contact shadow, tiny fabric compression, and slight local creases. Shadows must be soft and believable, never dramatic, glossy, floating, harsh, or unrealistic.",
    "If uncertain at any point, choose BACKGROUND-ONLY KEEP-CROP and preserve the uploaded product pixels and framing over making a cleaner or more complete image.",
  ].join("\n");
}

function buildKeepCropPrompt(productName) {
  return [
    "Use case: background-only replacement for a close-cropped XCLUSIVELINE product photo.",
    `Input image 1 is the product photo${productName ? ` named ${productName}` : ""}. It may already be tightly cropped and the item may touch or leave the frame edges.`,
    "Input image 2 is the original XCLUSIVELINE yellow fabric background. Use a clean yellow fabric area from it as the replacement surface.",
    "Do not create a new full-product flat-lay. Do not zoom out. Do not move, shrink, enlarge, rotate, re-angle, re-crop, or reframe the product.",
    "Preserve the exact uploaded camera crop and composition. Keep all visible product edges in the same positions and keep any naturally cut-off parts cut off.",
    "Preserve the exact number of visible products and their arrangement. If there are multiple items, keep the same items, same overlap order, same spacing, and same visible scale.",
    "Replace only the visible non-product background, such as grey, white, table, floor, or plain backdrop areas, with the yellow XCLUSIVELINE fabric texture.",
    "Do not generate, complete, or invent missing parts of the product outside the original frame. Do not add extra canvas, props, hands, hangers, floor, wall, labels, watermarks, or extra XCLUSIVELINE text.",
    "Preserve the product identity and details exactly: shape, colour, logos, printed text, texture, stitching, fabric grain, mesh holes, tags, defects, marks, shadows on the product, and edge detail.",
    "Do not smooth, repaint, recolour, relight, retouch, redesign, or restyle the product. Avoid AI smoothing and keep fabric/product texture real.",
    "Keep the existing product lighting and only add the minimum soft contact shadow needed where the product meets the new yellow background.",
    "The output should look like the same original close-up photo with only the background changed to yellow fabric.",
    "If anything is uncertain, preserve the uploaded product pixels and framing over making a more complete or cleaner product image.",
  ].join("\n");
}

function buildFlatlayPrompt(productName) {
  return [
    "Use case: realistic ecommerce flat-lay background replacement for XCLUSIVELINE.",
    `Input image 1 is the product photo${productName ? ` named ${productName}` : ""}.`,
    "Input image 2 is the original XCLUSIVELINE yellow fabric background. Use it as the physical ground/surface that the product is lying on.",
    "Create a 3:4 flat-lay product photo where the product appears naturally placed on top of that exact supplied background.",
    "Preserve the product identity and details: shape, colour, logos, printed text, texture, stitching, fabric grain, tags, hands, clothing, shoes, watches, defects, marks, and edge detail.",
    "Preserve the exact number of product items from the input. Do not add duplicates, alternate colourways, extra garments, props, or a new layout. If the input has a grouped set, keep the same group and overlap order.",
    "Do not smooth, repaint, recolour, relight, retouch, redesign, or restyle the product. Avoid AI smoothing and keep fabric/product texture real.",
    "Preserve the supplied XCLUSIVELINE background's yellow fabric texture and existing black lettering. Do not invent, duplicate, extend, or add any extra XCLUSIVELINE text, bottom text, watermarks, labels, props, hands, hangers, floor, or wall.",
    "Only add subtle realism where the product touches the background: a soft natural contact shadow, tiny fabric compression, and very slight local creases under or immediately around the product.",
    "Shadows must be soft and believable, not dramatic, floating, glossy, harsh, or unrealistic.",
    "Keep realistic scale and perspective. Size the product proportionally to the background like a real overhead camera photo, not an oversized cutout.",
    "Leave believable yellow fabric visible around the product on all sides. For most clothing, the product should usually fill about 50-68% of the canvas width or height; shoes, watches, and small accessories should appear smaller. Do not make the product touch the frame edges or dominate the entire background unless the original item is naturally very large.",
    "Center the product like a clean online store flat-lay; the product may naturally cover parts of the background lettering.",
    "If anything is uncertain, prioritize preserving the uploaded product and supplied background over making new details.",
  ].join("\n");
}

function shouldRetryWithRepeatedImageField(errorText) {
  return /image\[\]|unknown parameter|invalid parameter|missing required parameter|expected.*image|invalid image|image file|array/i.test(
    String(errorText || ""),
  );
}

function parseProductUrlItems(value) {
  if (!value) return [];

  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw statusError("Remote product image URLs were invalid.", 400);
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((item, index) => {
    const raw = typeof item === "string" ? { url: item } : item || {};
    const url = parseYupooImageUrl(raw.url);
    return {
      url: url.toString(),
      pageUrl: raw.pageUrl || `${url.origin}/`,
      filename: safeFilename(raw.filename || yupooFilename(url.toString(), index + 1, contentTypeFromImageUrl(url.toString()) || "image/jpeg")),
    };
  });
}

function parseYupooImageUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw statusError("Remote product image URL was invalid.", 400);
  }

  if (!["http:", "https:"].includes(url.protocol) || !isLikelyYupooProductImageUrl(url)) {
    throw statusError("Remote product image URL must be a Yupoo product photo.", 400);
  }

  url.protocol = "https:";
  url.hash = "";
  return url;
}

function yupooReferer(value, imageUrl) {
  try {
    const url = new URL(String(value || ""), `${imageUrl.origin}/`);
    if (["http:", "https:"].includes(url.protocol) && isYupooHost(url.hostname)) {
      url.protocol = "https:";
      return url.toString();
    }
  } catch {
    // Fall back to the image origin when the source page is absent or malformed.
  }
  return `${imageUrl.origin}/`;
}

async function fetchRemoteProductFile(item) {
  const url = parseYupooImageUrl(item.url);
  const response = await fetch(url.toString(), {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      referer: item.pageUrl || `${url.origin}/`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw statusError(`Yupoo image could not be downloaded (${response.status}).`, 502);
  }

  const fallbackType = contentTypeFromImageUrl(url.toString()) || "image/jpeg";
  const contentType = normalizeImageContentType(response.headers.get("content-type")) || fallbackType;
  if (!contentType.startsWith("image/")) {
    throw statusError("Yupoo returned a non-image response.", 502);
  }

  const buffer = await response.arrayBuffer();
  const maxMb = 20;
  if (buffer.byteLength > maxMb * 1024 * 1024) {
    throw statusError("Yupoo image is larger than 20MB.", 400);
  }

  const filename = safeFilename(item.filename || yupooFilename(url.toString(), 1, contentType));
  if (typeof File === "function") {
    return new File([buffer], filename, { type: contentType });
  }

  const blob = new Blob([buffer], { type: contentType });
  blob.name = filename;
  return blob;
}

function parseYupooPageUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw statusError("Paste a valid Yupoo link.", 400);
  }

  if (!["http:", "https:"].includes(url.protocol) || !isYupooHost(url.hostname)) {
    throw statusError("Paste a valid Yupoo link.", 400);
  }

  url.protocol = "https:";
  return url;
}

async function fetchYupooHtml(url) {
  const response = await fetch(url.toString(), {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-GB,en;q=0.9",
      referer: `${url.origin}/`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw statusError(`Yupoo link could not be loaded (${response.status}).`, 502);
  }

  return await response.text();
}

function extractYupooImageCandidates(html, pageUrl) {
  const candidates = [];
  let order = 0;
  const attrRegex = /\b(data-origin-src|data-src|src|href)=["']([^"']+)["']/gi;
  let match;

  while ((match = attrRegex.exec(html))) {
    const url = normalizeYupooImageUrl(match[2], pageUrl);
    if (!url) continue;
    candidates.push({
      url,
      pageUrl: pageUrl.toString(),
      score: yupooImageScore(url, match[1]),
      order: order++,
    });
  }

  const escapedRegex = /(?:https?:)?(?:\\\/\\\/|\/\/)photo\.yupoo\.com(?:\\\/|\/)[^"'<>\s)]+?(?:jpe?g|png|webp|gif|avif)/gi;
  while ((match = escapedRegex.exec(html))) {
    const url = normalizeYupooImageUrl(match[0], pageUrl);
    if (!url) continue;
    candidates.push({
      url,
      pageUrl: pageUrl.toString(),
      score: yupooImageScore(url, "embedded"),
      order: order++,
    });
  }

  return candidates;
}

function extractYupooAlbumLinks(html, pageUrl) {
  const links = [];
  const seen = new Set();
  const hrefRegex = /\bhref=["']([^"']+)["']/gi;
  let match;

  while ((match = hrefRegex.exec(html))) {
    const value = cleanEmbeddedUrl(match[1]);
    let url;
    try {
      url = new URL(value, pageUrl);
    } catch {
      continue;
    }
    if (!isYupooHost(url.hostname) || !/\/albums\/\d+/i.test(url.pathname)) continue;
    url.protocol = "https:";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(key);
  }

  return links;
}

function chooseBestYupooImages(candidates) {
  const bestByImage = new Map();

  for (const candidate of candidates) {
    const key = yupooImageFamilyKey(candidate.url);
    const existing = bestByImage.get(key);
    if (!existing) {
      bestByImage.set(key, candidate);
    } else if (candidate.score > existing.score) {
      bestByImage.set(key, { ...candidate, order: existing.order });
    }
  }

  return [...bestByImage.values()].sort((a, b) => a.order - b.order);
}

function normalizeYupooImageUrl(value, pageUrl) {
  let cleaned = cleanEmbeddedUrl(value);
  if (!cleaned || cleaned.startsWith("data:")) return null;
  if (cleaned.startsWith("//")) cleaned = `https:${cleaned}`;

  let url;
  try {
    url = new URL(cleaned, pageUrl);
  } catch {
    return null;
  }

  if (!isLikelyYupooProductImageUrl(url)) return null;
  url.protocol = "https:";
  url.hash = "";
  return url.toString();
}

function cleanEmbeddedUrl(value) {
  return decodeHtmlEntities(String(value || "").trim())
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/^["']|["']$/g, "");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&#39;/g, "'");
}

function isYupooHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "yupoo.com" || host.endsWith(".yupoo.com");
}

function isYupooPhotoHost(hostname) {
  return String(hostname || "").toLowerCase() === "photo.yupoo.com";
}

function isLikelyImageUrl(url) {
  const path = String(url.pathname || "").toLowerCase();
  return /\.(?:jpe?g|png|webp)$/.test(path) || /\/(?:big|small)\.jpe?g$/.test(path);
}

function isLikelyYupooProductImageUrl(url) {
  if (!isYupooPhotoHost(url.hostname) || !isLikelyImageUrl(url)) return false;
  const path = String(url.pathname || "").toLowerCase();
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return false;
  if (/(?:^|[-_/])(avatar|banner|brand|button|captcha|cart|close|empty|flag|icon|logo|qrcode|qr|search|sprite|wechat|weixin)(?:[-_.\/]|$)/i.test(path)) {
    return false;
  }
  return true;
}

function yupooImageScore(url, source) {
  const path = new URL(url).pathname.toLowerCase();
  let score = source === "data-origin-src" ? 100 : source === "data-src" ? 80 : source === "src" ? 50 : 35;
  if (!isLikelyYupooProductImageUrl(new URL(url))) score -= 1000;
  if (/\/(?:big)\.jpe?g$/.test(path)) score += 12;
  if (/\/(?:small)\.jpe?g$/.test(path)) score -= 18;
  if (/\/[a-f0-9]{6,}\.(?:jpe?g|png|webp|gif|avif)$/i.test(path)) score += 20;
  return score;
}

function yupooImageFamilyKey(value) {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "photo.yupoo.com" && parts.length >= 2) {
    return `${url.hostname}/${parts[0]}/${parts[1]}`;
  }
  return `${url.hostname}${url.pathname.replace(/\/(?:big|small)\.(jpe?g)$/i, "/$1")}`;
}

async function fetchYupooImage(imageUrl, referer) {
  const response = await fetch(imageUrl, {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      referer,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw statusError(`Yupoo image could not be downloaded (${response.status}).`, 502);
  }

  const fallbackType = contentTypeFromImageUrl(imageUrl) || "image/jpeg";
  const contentType = normalizeImageContentType(response.headers.get("content-type")) || fallbackType;
  if (!contentType.startsWith("image/")) {
    throw statusError("Yupoo returned a non-image response.", 502);
  }

  const buffer = await response.arrayBuffer();
  const maxMb = 20;
  if (buffer.byteLength > maxMb * 1024 * 1024) {
    throw statusError("Yupoo image is larger than 20MB.", 400);
  }

  return {
    contentType,
    size: buffer.byteLength,
    b64: arrayBufferToBase64(buffer),
  };
}

function normalizeImageContentType(value) {
  const type = String(value || "").split(";")[0].trim().toLowerCase();
  if (type === "image/jpg" || type === "image/pjpeg") return "image/jpeg";
  return type.startsWith("image/") ? type : "";
}

function openAiImageContentType(value) {
  const type = normalizeImageContentType(value);
  return ["image/jpeg", "image/png", "image/webp"].includes(type) ? type : "";
}

function contentTypeFromImageUrl(value) {
  const path = new URL(value).pathname.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "";
}

function yupooFilename(value, index, contentType) {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  let name = decodeURIComponent(parts.at(-1) || "");
  if (/^(?:big|small)\.jpe?g$/i.test(name) && parts.length >= 2) {
    name = `${parts.at(-2)}.${extensionForContentType(contentType)}`;
  }
  if (!/\.[a-z0-9]+$/i.test(name)) {
    name = `${name || "image"}.${extensionForContentType(contentType)}`;
  }
  return safeFilename(`yupoo-${String(index).padStart(2, "0")}-${name}`);
}

function extensionForContentType(contentType) {
  return (
    {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
    }[contentType] || "jpg"
  );
}

function outputSizeForModel(env, model) {
  const configured = env.XCLUSIVELINE_IMAGE_SIZE || env.OPENAI_IMAGE_SIZE;
  if (configured) return configured;
  return String(model || "").startsWith("gpt-image-2") ? "1200x1600" : "auto";
}

function outputSizeForMode(env, model, mode) {
  if (mode === "keep-crop") {
    return env.XCLUSIVELINE_KEEP_CROP_IMAGE_SIZE || env.OPENAI_KEEP_CROP_IMAGE_SIZE || "auto";
  }
  if (mode === "auto") {
    return env.XCLUSIVELINE_AUTO_IMAGE_SIZE || env.OPENAI_AUTO_IMAGE_SIZE || "auto";
  }
  return outputSizeForModel(env, model);
}

function normalizeGenerationMode(value) {
  const mode = String(value || "").toLowerCase();
  if (mode === "keep-crop") return "keep-crop";
  if (mode === "auto") return "auto";
  return "flatlay";
}

function parseProductModes(value, total, fallbackMode = "auto") {
  const fallback = normalizeGenerationMode(fallbackMode);
  if (!value) return Array.from({ length: total }, () => fallback);

  let parsed = [];
  try {
    parsed = JSON.parse(String(value));
  } catch {
    parsed = [];
  }

  if (!Array.isArray(parsed)) parsed = [];
  return Array.from({ length: total }, (_, index) => normalizeGenerationMode(parsed[index] || fallback));
}

function outputQualityForEnv(env) {
  const quality = String(env.XCLUSIVELINE_IMAGE_QUALITY || env.OPENAI_IMAGE_QUALITY || "high").toLowerCase();
  return ["low", "medium", "high", "auto"].includes(quality) ? quality : "high";
}

function outputFormatForEnv(env) {
  const format = String(env.XCLUSIVELINE_OUTPUT_FORMAT || env.OPENAI_OUTPUT_FORMAT || "jpeg").toLowerCase();
  return ["png", "jpeg", "webp"].includes(format) ? format : "jpeg";
}

function outputCompressionForEnv(env) {
  const value = Number(env.XCLUSIVELINE_OUTPUT_COMPRESSION || env.OPENAI_OUTPUT_COMPRESSION || 95);
  if (!Number.isFinite(value)) return 95;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function contentTypeForOutputFormat(format) {
  return (
    {
      png: PNG_TYPE,
      jpeg: JPEG_TYPE,
      webp: WEBP_TYPE,
    }[format] || JPEG_TYPE
  );
}

async function getDefaultBackground(request, env) {
  const background = await loadDefaultBackgroundResponse(request, env);
  return new Response(background.body, {
    headers: {
      "content-type": background.headers.get("content-type") || "image/png",
      "cache-control": "public, max-age=3600",
      ...corsHeaders(request, env),
    },
  });
}

async function loadDefaultBackgroundFile(request, env) {
  const response = await loadDefaultBackgroundResponse(request, env);
  const contentType = response.headers.get("content-type") || "image/png";
  return new Blob([await response.arrayBuffer()], { type: contentType });
}

async function loadDefaultBackgroundResponse(request, env) {
  const configuredUrl = env.XCLUSIVELINE_BACKGROUND_URL || BRAND.defaultBackgroundUrl;
  const response = env.ASSETS
    ? await env.ASSETS.fetch(new Request(new URL(BRAND.defaultBackgroundPath, request.url).toString(), { method: "GET" }))
    : await fetch(configuredUrl);
  if (!response.ok) {
    throw statusError("Default XCLUSIVELINE background asset was not found.", 500);
  }
  return response;
}

async function requireAdmin(request, env) {
  if (!studioRequiresAdminToken(env)) {
    return true;
  }

  const configuredToken = env.XCLUSIVELINE_STUDIO_ADMIN_TOKEN || env.ADMIN_TOKEN;
  if (!configuredToken) {
    throw statusError("Studio admin token enforcement is enabled but no token is configured.", 500);
  }

  const url = new URL(request.url);
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  const supplied = bearer || request.headers.get("x-admin-token") || url.searchParams.get("token") || "";

  if (supplied !== configuredToken) {
    throw statusError("Unauthorized. Set the XCLUSIVELINE admin token in the studio.", 401);
  }

  return true;
}

function studioRequiresAdminToken(env) {
  const value = env.XCLUSIVELINE_REQUIRE_ADMIN_TOKEN || env.REQUIRE_ADMIN_TOKEN || "";
  return ["1", "true", "yes"].includes(String(value).trim().toLowerCase());
}

function validateImageFile(file, label) {
  if (!file || typeof file !== "object" || !file.size) {
    throw statusError(`${label} is missing.`, 400);
  }

  const maxMb = 20;
  if (file.size > maxMb * 1024 * 1024) {
    throw statusError(`${label} is larger than ${maxMb}MB.`, 400);
  }

  return openAiImageContentType(file.type || "");
}

async function normalizeImageFileForOpenAi(file, label) {
  const declaredContentType = validateImageFile(file, label);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedContentType = detectImageContentType(bytes);
  const contentType = detectedContentType || declaredContentType;

  if (!openAiImageContentType(contentType)) {
    throw statusError(`${label} must be a JPEG, PNG, or WebP image file.`, 400);
  }

  const filename = normalizedImageFilename(file.name, label, contentType);
  if (typeof File === "function") {
    return new File([bytes], filename, { type: contentType });
  }

  const blob = new Blob([bytes], { type: contentType });
  blob.name = filename;
  return blob;
}

function detectImageContentType(bytes) {
  if (!bytes || bytes.length < 4) return "";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return PNG_TYPE;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return JPEG_TYPE;
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return WEBP_TYPE;
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (["avif", "heic", "heix", "hevc", "mif1"].includes(brand)) return `image/${brand}`;
  }
  return "";
}

function normalizedImageFilename(name, label, contentType) {
  const fallback = safeFilename(label || "image");
  const base = safeFilename(String(name || fallback).replace(/\.[a-z0-9]+$/i, "")) || fallback;
  return `${base}.${extensionForContentType(contentType)}`;
}

function json(data, request, env, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": JSON_TYPE,
      ...corsHeaders(request, env),
    },
  });
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("origin");
  const allowed = String(env.XCLUSIVELINE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowOrigin = !requestOrigin || allowed.includes(requestOrigin) ? requestOrigin || "*" : allowed[0] || "*";

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-admin-token",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function maxBulkImages(env) {
  return Math.max(1, Math.min(Number(env.XCLUSIVELINE_MAX_BULK_IMAGES || 24), 24));
}

function yupooImportLimit(env, requested) {
  return Math.max(1, Math.min(Number(requested || env.XCLUSIVELINE_YUPOO_IMPORT_LIMIT || 24), 60));
}

function outputFilename(originalName, id, contentType) {
  const base = safeFilename(originalName || "product.png").replace(/\.[a-z0-9]+$/i, "");
  return `${base}-xclusiveline-bg-${id.slice(0, 8)}.${extensionForContentType(contentType)}`;
}

function safeFilename(value) {
  return String(value || "xclusiveline-output.png")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "xclusiveline-output.png";
}

function cleanPrefix(value) {
  const prefix = String(value || "").replace(/^\/+/, "");
  return prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
}

function mediaPublicUrl(env, key) {
  const base = env.XCLUSIVELINE_R2_PUBLIC_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function stripDataUrl(value) {
  const text = String(value || "");
  const marker = ";base64,";
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : text;
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
