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
  const normalizedBackgroundFile = normalizeImageFileForOpenAi(backgroundFile, "XCLUSIVELINE background");

  const results = [];
  const errors = [];

  for (let index = 0; index < productFiles.length; index += 1) {
    let productFile = productFiles[index];
    try {
      productFile = normalizeImageFileForOpenAi(productFile, `Product ${index + 1}`);
      const generated = await generateFlatlayComposite({
        env,
        productFile,
        backgroundFile: normalizedBackgroundFile,
        generationMode,
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
    const contentType = image.contentType || PNG_TYPE;
    const b64 = stripDataUrl(image.b64 || image.dataUrl || "");
    if (!b64) {
      throw statusError("Saved image is missing base64 content.", 400);
    }

    const key = `${prefix}generated/${datePath}/${crypto.randomUUID()}-${safeFilename(image.filename || "xclusiveline-output.png")}`;
    const bytes = base64ToUint8Array(b64);

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
  if (!key.startsWith(allowedPrefix)) {
    throw statusError("Media key is outside the generated image library.", 400);
  }

  await env.XCLUSIVELINE_MEDIA.delete(key);
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
  return mode === "keep-crop" ? buildKeepCropPrompt(productName) : buildFlatlayPrompt(productName);
}

function buildKeepCropPrompt(productName) {
  return [
    "Use case: background-only replacement for a close-cropped XCLUSIVELINE product photo.",
    `Input image 1 is the product photo${productName ? ` named ${productName}` : ""}. It may already be tightly cropped and the item may touch or leave the frame edges.`,
    "Input image 2 is the original XCLUSIVELINE yellow fabric background. Use a clean yellow fabric area from it as the replacement surface.",
    "Do not create a new full-product flat-lay. Do not zoom out. Do not move, shrink, enlarge, rotate, re-angle, re-crop, or reframe the product.",
    "Preserve the exact uploaded camera crop and composition. Keep all visible product edges in the same positions and keep any naturally cut-off parts cut off.",
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
    "Do not smooth, repaint, recolour, relight, retouch, redesign, or restyle the product. Avoid AI smoothing and keep fabric/product texture real.",
    "Preserve the supplied XCLUSIVELINE background's yellow fabric texture and existing black lettering. Do not invent, duplicate, extend, or add any extra XCLUSIVELINE text, bottom text, watermarks, labels, props, hands, hangers, floor, or wall.",
    "Only add subtle realism where the product touches the background: a soft natural contact shadow, tiny fabric compression, and very slight local creases under or immediately around the product.",
    "Shadows must be soft and believable, not dramatic, floating, glossy, harsh, or unrealistic.",
    "Keep realistic scale and perspective. Size the product proportionally to the background like a real overhead camera photo, not an oversized cutout.",
    "Leave believable yellow fabric visible around the product on all sides. For most clothing, the product should usually fill about 55-75% of the canvas width or height; shoes, watches, and small accessories should appear smaller. Do not make the product touch the frame edges or dominate the entire background unless the original item is naturally very large.",
    "Center the product like a clean online store flat-lay; the product may naturally cover parts of the background lettering.",
    "If anything is uncertain, prioritize preserving the uploaded product and supplied background over making new details.",
  ].join("\n");
}

function shouldRetryWithRepeatedImageField(errorText) {
  return /image\[\]|unknown parameter|invalid parameter|missing required parameter|expected.*image|array/i.test(
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
  return outputSizeForModel(env, model);
}

function normalizeGenerationMode(value) {
  return String(value || "").toLowerCase() === "keep-crop" ? "keep-crop" : "flatlay";
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

  const contentType = openAiImageContentType(file.type || "");
  if (!contentType) {
    throw statusError(`${label} must be a JPEG, PNG, or WebP image file.`, 400);
  }

  const maxMb = 20;
  if (file.size > maxMb * 1024 * 1024) {
    throw statusError(`${label} is larger than ${maxMb}MB.`, 400);
  }

  return contentType;
}

function normalizeImageFileForOpenAi(file, label) {
  const contentType = validateImageFile(file, label);
  if (file.type === contentType) return file;

  const filename = file.name || `${safeFilename(label)}.${extensionForContentType(contentType)}`;
  if (typeof File === "function") {
    return new File([file], filename, { type: contentType });
  }

  const blob = new Blob([file], { type: contentType });
  blob.name = filename;
  return blob;
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
  return Math.max(1, Math.min(Number(env.XCLUSIVELINE_MAX_BULK_IMAGES || 8), 20));
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
