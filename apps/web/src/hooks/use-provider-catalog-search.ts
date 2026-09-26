import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";

import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { orpc } from "@/utils/orpc";

export const CATALOG_SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 20;

/**
 * Debounced, paged OpenRouter catalog search. The server trims rows and
 * computes compatibility verdicts; the browser never receives the catalog.
 */
export function useProviderCatalogSearch(options: {
  query: string;
  poolId?: string;
  toolsOnly?: boolean;
  enabled?: boolean;
}) {
  const query = useDebouncedValue(options.query.trim(), CATALOG_SEARCH_DEBOUNCE_MS);
  const base = {
    query,
    ...(options.poolId ? { poolId: options.poolId } : {}),
    filters: options.toolsOnly ? { tools: true } : {},
    limit: PAGE_SIZE,
  };
  const search = useInfiniteQuery({
    ...orpc.providerCatalog.search.infiniteOptions({
      input: (cursor: number | undefined) => ({
        ...base,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const pages = search.data?.pages ?? [];
  const first = pages[0];
  return {
    rows: pages.flatMap((page) => page.items),
    status: first?.status,
    stale: first?.status === "ok" && first.stale,
    isPending: search.isPending,
    isError: search.isError,
    isSettling: query !== options.query.trim() || (search.isFetching && !search.isFetchingNextPage),
    hasNextPage: search.hasNextPage,
    isFetchingNextPage: search.isFetchingNextPage,
    fetchNextPage: () => void search.fetchNextPage(),
    refetch: () => void search.refetch(),
  };
}
