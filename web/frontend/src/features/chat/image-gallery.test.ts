import { describe, expect, it } from "vitest"

import type { ChatMessage } from "@/store/chat"

import {
  buildImageGallery,
  galleryIndex,
  horizontalSwipe,
  isSafeImageSource,
} from "./image-gallery"

describe("conversation image gallery", () => {
  it("indexes both roles, preserving image position independently of other attachments", () => {
    const messages = [
      {
        id: "old",
        role: "user",
        attachments: [
          { type: "file", url: "/a" },
          { type: "image", url: "/1" },
          { type: "image", url: "/2" },
        ],
      },
      {
        id: "new",
        role: "assistant",
        attachments: [{ type: "image", url: "/3" }],
      },
    ] as ChatMessage[]
    const gallery = buildImageGallery(messages)
    expect(
      gallery.map(({ messageId, imageIndex }) => [messageId, imageIndex]),
    ).toEqual([
      ["old", 0],
      ["old", 1],
      ["new", 0],
    ])
    expect(galleryIndex(gallery, { messageId: "new", imageIndex: 0 })).toBe(2)
    expect(
      galleryIndex(buildImageGallery(messages.slice(1)), {
        messageId: "new",
        imageIndex: 0,
      }),
    ).toBe(0)
  })
  it("rejects executable sources while keeping image data URLs", () => {
    expect(isSafeImageSource("javascript:alert(1)")).toBe(false)
    expect(isSafeImageSource("data:text/html;base64,PHNjcmlwdD4=")).toBe(false)
    expect(isSafeImageSource("data:image/png;base64,aGVsbG8=")).toBe(true)
    expect(isSafeImageSource("//evil.test/a")).toBe(false)
    expect(isSafeImageSource("")).toBe(false)
    expect(isSafeImageSource("/api/media/1")).toBe(true)
  })
  it("requires a dominant horizontal gesture", () => {
    expect(horizontalSwipe(-80, 12)).toBe(1)
    expect(horizontalSwipe(80, 12)).toBe(-1)
    expect(horizontalSwipe(40, 0)).toBe(0)
    expect(horizontalSwipe(80, 75)).toBe(0)
  })
})
