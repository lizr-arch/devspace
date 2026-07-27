declare module "*.css";

interface OpenAISelectedFile {
  fileId: string;
  fileName?: string;
  mimeType?: string;
}

interface Window {
  openai?: {
    selectFiles?: () => Promise<OpenAISelectedFile[]>;
    getFileDownloadUrl?: (input: {
      fileId: string;
    }) => Promise<{ downloadUrl: string }>;
  };
}
