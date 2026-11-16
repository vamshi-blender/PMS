import extensionPackage from "../../chrome-extension/package.json";
import { signedReleaseUrl, storageConfigured } from "@/lib/extension/release.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// The stable download link. The zip sits in a private Supabase Storage bucket,
// so each click gets a one-minute signed link and is redirected straight to it:
// the file is served by Supabase, not by this server.
export async function GET() {
  const { version } = extensionPackage;
  if (!storageConfigured()) {
    return Response.json({ error: "Extension downloads are not configured on this server." }, { status: 503, headers: NO_STORE });
  }

  try {
    const url = await signedReleaseUrl(version);
    if (!url) {
      return Response.json({ error: `Donna ${version} has not been published yet.` }, { status: 404, headers: NO_STORE });
    }
    return new Response(null, { status: 302, headers: { ...NO_STORE, Location: url } });
  } catch (error) {
    console.error("Failed to create an extension download link", error);
    return Response.json({ error: "Could not start the download. Please try again." }, { status: 502, headers: NO_STORE });
  }
}
