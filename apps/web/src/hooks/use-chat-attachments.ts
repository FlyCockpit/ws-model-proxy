import { useState } from "react";

/** Composer-only attachment state. Sent attachments belong to the thread and
 * are intentionally never mutated here. */
export function useChatAttachments<Attachment>() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [attachmentNoticeIsError, setAttachmentNoticeIsError] = useState(false);
  const [isProcessingImages, setIsProcessingImages] = useState(false);
  const [videoCompressionProgress, setVideoCompressionProgress] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  return {
    attachments,
    setAttachments,
    attachmentNotice,
    setAttachmentNotice,
    attachmentNoticeIsError,
    setAttachmentNoticeIsError,
    isProcessingImages,
    setIsProcessingImages,
    videoCompressionProgress,
    setVideoCompressionProgress,
    isDragging,
    setIsDragging,
  };
}
