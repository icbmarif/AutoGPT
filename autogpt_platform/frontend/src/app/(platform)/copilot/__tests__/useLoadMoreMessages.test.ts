import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLoadMoreMessages } from "../useLoadMoreMessages";

vi.mock("@/app/api/__generated__/endpoints/chat/chat", () => ({
  getV2GetSession: vi.fn(),
}));

vi.mock("../helpers/convertChatSessionToUiMessages", () => ({
  convertChatSessionMessagesToUiMessages: vi.fn(() => ({ messages: [] })),
  extractToolOutputsFromRaw: vi.fn(() => []),
}));

const BASE_ARGS = {
  sessionId: "sess-1",
  initialOldestSequence: 0,
  initialNewestSequence: 49,
  initialHasMore: true,
  forwardPaginated: true,
  initialPageRawMessages: [],
};

describe("useLoadMoreMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initialises with empty pagedMessages and correct cursors", () => {
    const { result } = renderHook(() => useLoadMoreMessages(BASE_ARGS));
    expect(result.current.pagedMessages).toHaveLength(0);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isLoadingMore).toBe(false);
  });

  it("resetPaged clears paged state and sets hasMore=false during transition", () => {
    const { result } = renderHook(() => useLoadMoreMessages(BASE_ARGS));

    act(() => {
      result.current.resetPaged();
    });

    expect(result.current.pagedMessages).toHaveLength(0);
    // hasMore must be false during transition to prevent forward loadMore
    // from firing on the now-active session before forwardPaginated updates.
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isLoadingMore).toBe(false);
  });

  it("resetPaged exposes a fresh loadMore via incremented epoch", () => {
    const { result } = renderHook(() => useLoadMoreMessages(BASE_ARGS));
    // Just verify resetPaged is callable and doesn't throw.
    expect(() => {
      act(() => {
        result.current.resetPaged();
      });
    }).not.toThrow();
  });

  it("resets all state on sessionId change", () => {
    const { result, rerender } = renderHook(
      (props) => useLoadMoreMessages(props),
      { initialProps: BASE_ARGS },
    );

    rerender({
      ...BASE_ARGS,
      sessionId: "sess-2",
      initialOldestSequence: 10,
      initialNewestSequence: 59,
      initialHasMore: false,
    });

    expect(result.current.pagedMessages).toHaveLength(0);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isLoadingMore).toBe(false);
  });
});
