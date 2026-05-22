import { revalidatePath, revalidateTag } from "next/cache";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const tags = Array.isArray(body.tags)
    ? body.tags
    : typeof body.tag === "string"
      ? [body.tag]
      : [];
  const paths = Array.isArray(body.paths)
    ? body.paths
    : typeof body.path === "string"
      ? [body.path]
      : [];

  for (const tag of tags) {
    if (typeof tag === "string") revalidateTag(tag, "max");
  }
  for (const path of paths) {
    if (typeof path === "string") revalidatePath(path);
  }

  return Response.json({
    ok: true,
    paths,
    tags,
    revalidatedAt: Date.now(),
  });
}
