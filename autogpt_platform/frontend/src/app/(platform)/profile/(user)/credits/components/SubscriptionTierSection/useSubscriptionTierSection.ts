import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useGetSubscriptionStatus,
  useUpdateSubscriptionTier,
} from "@/app/api/__generated__/endpoints/credits/credits";
import type { SubscriptionStatusResponse } from "@/app/api/__generated__/models/subscriptionStatusResponse";
import type { SubscriptionTierRequestTier } from "@/app/api/__generated__/models/subscriptionTierRequestTier";
import { useToast } from "@/components/molecules/Toast/use-toast";

export type SubscriptionStatus = SubscriptionStatusResponse;

export function useSubscriptionTierSection() {
  const searchParams = useSearchParams();
  const subscriptionStatus = searchParams.get("subscription");
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [tierError, setTierError] = useState<string | null>(null);

  const {
    data: subscription,
    isLoading,
    error: queryError,
    refetch,
  } = useGetSubscriptionStatus({
    query: { select: (data) => (data.status === 200 ? data.data : null) },
  });

  const fetchError = queryError ? "Failed to load subscription info" : null;

  const {
    mutateAsync: doUpdateTier,
    isPending,
    variables,
  } = useUpdateSubscriptionTier();

  useEffect(() => {
    if (subscriptionStatus === "success") {
      refetch();
      toast({
        title: "Subscription upgraded",
        description:
          "Your plan has been updated. It may take a moment to reflect.",
      });
      // Strip ?subscription=success from the URL so a page refresh does not
      // re-trigger the toast, and so a second checkout in the same session
      // correctly fires the toast again.
      router.replace(pathname);
    }
  }, [subscriptionStatus, refetch, toast, router, pathname]);

  async function changeTier(tier: string) {
    setTierError(null);
    try {
      const successUrl = `${window.location.origin}${window.location.pathname}?subscription=success`;
      const cancelUrl = `${window.location.origin}${window.location.pathname}?subscription=cancelled`;
      const result = await doUpdateTier({
        data: {
          tier: tier as SubscriptionTierRequestTier,
          success_url: successUrl,
          cancel_url: cancelUrl,
        },
      });
      if (result.status === 200 && result.data.url) {
        window.location.href = result.data.url;
        return;
      }
      await refetch();
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Failed to change subscription tier";
      setTierError(msg);
    }
  }

  const pendingTier =
    isPending && variables?.data?.tier ? variables.data.tier : null;

  return {
    subscription: subscription ?? null,
    isLoading,
    error: fetchError,
    tierError,
    isPending,
    pendingTier,
    changeTier,
  };
}
