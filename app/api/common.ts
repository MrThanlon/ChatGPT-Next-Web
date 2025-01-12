import { NextRequest, NextResponse } from "next/server";
import { Axiom } from "@axiomhq/js";

export const OPENAI_URL = "api.openai.com";
const DEFAULT_PROTOCOL = "https";
const PROTOCOL = process.env.PROTOCOL || DEFAULT_PROTOCOL;
const BASE_URL = process.env.BASE_URL || OPENAI_URL;
const DISABLE_GPT4 = !!process.env.DISABLE_GPT4;

const axiom = new Axiom({
  token: process.env.AXIOM_TOKEN,
  orgId: process.env.AXIOM_ORG_ID,
});

export async function requestOpenai(req: NextRequest) {
  const controller = new AbortController();
  const authValue = req.headers.get("Authorization") ?? "";
  const openaiPath = `${req.nextUrl.pathname}${req.nextUrl.search}`.replaceAll(
    "/api/openai/",
    "",
  );

  let baseUrl = BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `${PROTOCOL}://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", openaiPath);
  console.log("[Base Url]", baseUrl);

  if (process.env.OPENAI_ORG_ID) {
    console.log("[Org ID]", process.env.OPENAI_ORG_ID);
  }

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  const fetchUrl = `${baseUrl}/${openaiPath}`;
  let reqJson: any;
  if (req.method === "POST") {
    reqJson = await req.json();
  }
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Authorization: authValue,
      ...(process.env.OPENAI_ORG_ID && {
        "OpenAI-Organization": process.env.OPENAI_ORG_ID,
      }),
    },
    method: req.method,
    body: req.method === "POST" ? JSON.stringify(reqJson) : req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // #1815 try to refuse gpt4 request
  if (DISABLE_GPT4 && req.body) {
    try {
      const clonedBody = reqJson;
      fetchOptions.body = clonedBody;

      const jsonBody = clonedBody;

      if ((jsonBody?.model ?? "").includes("gpt-4")) {
        return NextResponse.json(
          {
            error: true,
            message: "you are not allowed to use gpt-4 model",
          },
          {
            status: 403,
          },
        );
      }
    } catch (e) {
      console.error("[OpenAI] gpt4 filter", e);
    }
  }

  try {
    const res = await fetch(fetchUrl, fetchOptions);

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // log
    if (
      process.env.AXIOM_TOKEN &&
      process.env.AXIOM_ORG_ID &&
      req.method === "POST"
    ) {
      if (!res.body) {
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: newHeaders,
        });
      }
      const rets = res.body.tee();
      // axiom.ingestRaw(process.env.AXIOM_DATASET || "gpt", statis[0])
      axiom.flush();
      // statistics
      const reader = rets[1].getReader();
      let tokens = reqJson.messages.reduce(
        (pre: number, cur: any) => pre + cur.content.length,
        0,
      );
      const decoder = new TextDecoder("utf-8");
      let response = "";
      reader.read().then(function handler({ value, done }) {
        const text = decoder.decode(value);
        text.split("\n\n").forEach((val) => {
          try {
            const data = JSON.parse(val.substring(6));
            const content = data.choices?.at(0)?.delta?.content;
            if (content) {
              response += content;
              tokens += content.length;
            }
          } catch (e) {}
        });
        if (done) {
          axiom.ingest(process.env.AXIOM_DATASET || "gpt", [
            {
              key: req.headers.get("Authorization")?.substring(7),
              tokens,
              ...reqJson,
              response,
            },
          ]);
          axiom.flush();
          return;
        }
        reader.read().then(handler);
      });
      return new Response(rets[0], {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    } else {
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
