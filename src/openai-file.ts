import * as z from "zod/v4";

export const openAiFileInputSchema = z
  .object({
    download_url: z.string(),
    file_id: z.string().min(1).max(512),
    mime_type: z.string().max(255).optional(),
    file_name: z.string().min(1).max(255).optional(),
  })
  .strict();

export const IMPORT_PNG_FILE_PARAMS_META = {
  "openai/fileParams": ["file"],
} as const;
