import { createConfigExportZip } from "~/lib/config-export"

export async function handleExportSettings(): Promise<Response> {
  const archive = await createConfigExportZip()
  return new Response(archive.zip, {
    headers: {
      "content-disposition": `attachment; filename="${archive.filename}"`,
      "content-type": "application/zip",
    },
  })
}
