const BRAND = {
  name: "XCLUSIVELINE",
  yellow: "#F5A800",
  black: "#0A0A0A",
  white: "#FAFAFA",
  defaultBackgroundPath: "/xclusiveline-background.jpg",
  defaultBackgroundUrl: "https://qmako4.github.io/xclusiveline/assets/xclusiveline-studio-background.jpg",
};

const JSON_TYPE = "application/json; charset=utf-8";
const PNG_TYPE = "image/png";

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
        return json(
          {
            ok: true,
            brand: BRAND,
            imageSize: env.XCLUSIVELINE_IMAGE_SIZE || "1024x1536",
            maxBulkImages: maxBulkImages(env),
            saveEnabled: Boolean(env.XCLUSIVELINE_MEDIA),
            publicMediaBaseUrl: env.XCLUSIVELINE_R2_PUBLIC_URL || null,
          },
          request,
          env,
        );
      }

      if (pathname === "/api/background" && request.method === "GET") {
        return getDefaultBackground(request, env);
      }

      if (pathname === "/api/generate" && request.method === "POST") {
        await requireAdmin(request, env);
        return generatePreviews(request, env);
      }

      if (pathname === "/api/save" && request.method === "POST") {
        await requireAdmin(request, env);
        return saveGeneratedImages(request, env);
      }

      if (pathname === "/api/media" && request.method === "GET") {
        await requireAdmin(request, env);
        return listMedia(request, env);
      }

      if (pathname === "/api/media/raw" && request.method === "GET") {
        await requireAdmin(request, env);
        return getMediaObject(request, env);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({ ok: false, error: "Not found" }, request, env, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || "Request failed" }, request, env, error.status || 500);
    }
  },
};

async function generatePreviews(request, env) {
  const form = await request.formData();
  const productFiles = form
    .getAll("products")
    .filter((file) => file && typeof file === "object" && file.size > 0);

  if (!productFiles.length) {
    throw statusError("Upload at least one product image.", 400);
  }

  if (productFiles.length > maxBulkImages(env)) {
    throw statusError(`Upload ${maxBulkImages(env)} images or fewer per batch.`, 400);
  }

  const backgroundOverride = form.get("background");
  const backgroundFile =
    backgroundOverride && typeof backgroundOverride === "object" && backgroundOverride.size > 0
      ? backgroundOverride
      : await loadDefaultBackgroundFile(request, env);

  const results = [];
  const errors = [];

  for (let index = 0; index < productFiles.length; index += 1) {
    const productFile = productFiles[index];
    try {
      validateImageFile(productFile, `Product ${index + 1}`);
      validateImageFile(backgroundFile, "Background");

      const generated = await generateBackgroundSwap({
        env,
        productFile,
        backgroundFile,
      });

      const id = crypto.randomUUID();
      const filename = outputFilename(productFile.name, id);
      results.push({
        id,
        originalName: productFile.name || `product-${index + 1}`,
        filename,
        contentType: generated.contentType,
        b64: generated.b64,
        dataUrl: `data:${generated.contentType};base64,${generated.b64}`,
        prompt: generated.prompt,
        imageSize: env.XCLUSIVELINE_IMAGE_SIZE || "1024x1536",
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

async function generateBackgroundSwap({ env, productFile, backgroundFile }) {
  const apiKey = env.OPENAI_API_KEY || env.XCLUSIVELINE_OPENAI_API_KEY;
  if (!apiKey) {
    throw statusError("Missing OPENAI_API_KEY or XCLUSIVELINE_OPENAI_API_KEY.", 500);
  }

  const prompt = buildBackgroundSwapPrompt(productFile.name);
  const model = env.XCLUSIVELINE_OPENAI_IMAGE_MODEL || env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const size = env.XCLUSIVELINE_IMAGE_SIZE || "1024x1536";
  const firstAttempt = await callOpenAiImagesEdit({
    apiKey,
    model,
    size,
    prompt,
    productFile,
    backgroundFile,
    fieldMode: "array",
  });

  if (!firstAttempt.ok && shouldRetryWithRepeatedImageField(firstAttempt.errorText)) {
    const retry = await callOpenAiImagesEdit({
      apiKey,
      model,
      size,
      prompt,
      productFile,
      backgroundFile,
      fieldMode: "repeated",
    });
    if (retry.ok) {
      return { ...retry.image, prompt };
    }
    throw statusError(`OpenAI image edit failed: ${retry.errorText}`, 502);
  }

  if (!firstAttempt.ok) {
    throw statusError(`OpenAI image edit failed: ${firstAttempt.errorText}`, 502);
  }

  return { ...firstAttempt.image, prompt };
}

async function callOpenAiImagesEdit({ apiKey, model, size, prompt, productFile, backgroundFile, fieldMode }) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);

  if (fieldMode === "array") {
    form.append("image[]", productFile, productFile.name || "product.png");
    form.append("image[]", backgroundFile, backgroundFile.name || "xclusiveline-background.jpg");
  } else {
    form.append("image", productFile, productFile.name || "product.png");
    form.append("image", backgroundFile, backgroundFile.name || "xclusiveline-background.jpg");
  }

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
        contentType: PNG_TYPE,
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

function buildBackgroundSwapPrompt(productName) {
  return [
    "Use case: precise-object-edit",
    "Asset type: XCLUSIVELINE product photo studio background replacement",
    `Input image 1: product image${productName ? ` named ${productName}` : ""}. This is the edit target. Preserve the product exactly.`,
    "Input image 2: XCLUSIVELINE yellow and black branded background. Use it as the background reference.",
    "Primary request: replace only the original background behind the product with the XCLUSIVELINE background. Keep the product, product shape, product colour, logos, texture, hand, clothing, shoe, watch, item details, edges, and perspective unchanged.",
    "Composition/framing: final output must be vertical 3:4 ecommerce format. Keep realistic product scale and perspective. Center the product with comfortable margin. If the source crop is not 3:4, extend or crop only the background area as needed.",
    "Lighting/mood: simple realistic product photo lighting. Keep natural contact and edge shadows only when they already make sense. No dramatic, fake, or unrealistic shadows.",
    "Generative fill rule: use generative fill only for missing background canvas or tiny edge cleanup needed to fit 3:4. Never regenerate, redraw, restyle, recolour, resize, or invent product details.",
    "Constraints: no extra products, no new hands, no new logos, no watermark, no text except background text that already exists in the supplied XCLUSIVELINE background, no changed product details, no fashion editorial scene, no unrealistic shadows.",
  ].join("\n");
}

async function getDefaultBackground(request, env) {
  const background = await loadDefaultBackgroundResponse(request, env);
  return new Response(background.body, {
    headers: {
      "content-type": background.headers.get("content-type") || "image/jpeg",
      "cache-control": "public, max-age=3600",
      ...corsHeaders(request, env),
    },
  });
}

async function loadDefaultBackgroundFile(request, env) {
  const response = await loadDefaultBackgroundResponse(request, env);
  const contentType = response.headers.get("content-type") || "image/jpeg";
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
  const configuredToken = env.XCLUSIVELINE_STUDIO_ADMIN_TOKEN || env.ADMIN_TOKEN;
  if (!configuredToken) {
    return true;
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

function validateImageFile(file, label) {
  if (!file || typeof file !== "object" || !file.size) {
    throw statusError(`${label} is missing.`, 400);
  }

  if (!String(file.type || "").startsWith("image/")) {
    throw statusError(`${label} must be an image file.`, 400);
  }

  const maxMb = 20;
  if (file.size > maxMb * 1024 * 1024) {
    throw statusError(`${label} is larger than ${maxMb}MB.`, 400);
  }
}

function shouldRetryWithRepeatedImageField(message = "") {
  return /image\[\]|invalid.*image|unknown.*parameter|array/i.test(message);
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

function outputFilename(originalName, id) {
  const base = safeFilename(originalName || "product.png").replace(/\.[a-z0-9]+$/i, "");
  return `${base}-xclusiveline-bg-${id.slice(0, 8)}.png`;
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
