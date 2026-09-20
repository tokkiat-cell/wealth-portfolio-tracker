import { useCallback, useEffect, useState } from "react";
import type { Overview } from "../../shared/schema";
import { ApiError, api } from "./api";

// Loads the portfolio and lets any screen ask for a refresh after it changes something.
export function useOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setData(await api.overview());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError("Could not load your portfolio", 0));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}
