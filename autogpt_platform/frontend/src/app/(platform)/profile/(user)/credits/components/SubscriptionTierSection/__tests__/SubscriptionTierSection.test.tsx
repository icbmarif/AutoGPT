import { render, screen, fireEvent, waitFor, cleanup } from "@/tests/integrations/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionTierSection } from "../SubscriptionTierSection";

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useSearchParams: () => mockSearchParams,
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => "/profile/credits",
  };
});

// Mock toast
const mockToast = vi.fn();
vi.mock("@/components/molecules/Toast/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Mock generated API hooks
const mockUseGetSubscriptionStatus = vi.fn();
const mockUseUpdateSubscriptionTier = vi.fn();
vi.mock("@/app/api/__generated__/endpoints/credits/credits", () => ({
  useGetSubscriptionStatus: (opts: unknown) =>
    mockUseGetSubscriptionStatus(opts),
  useUpdateSubscriptionTier: () => mockUseUpdateSubscriptionTier(),
}));

// Mock Dialog (Radix portals don't work in happy-dom)
vi.mock("@/components/__legacy__/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

function makeSubscription({
  tier = "FREE",
  monthlyCost = 0,
  tierCosts = { FREE: 0, PRO: 1999, BUSINESS: 4999, ENTERPRISE: 0 },
}: {
  tier?: string;
  monthlyCost?: number;
  tierCosts?: Record<string, number>;
} = {}) {
  return {
    tier,
    monthly_cost: monthlyCost,
    tier_costs: tierCosts,
  };
}

function setupMocks({
  subscription = makeSubscription(),
  isLoading = false,
  queryError = null as Error | null,
  mutateFn = vi.fn().mockResolvedValue({ status: 200, data: { url: "" } }),
  isPending = false,
  variables = undefined as { data?: { tier?: string } } | undefined,
} = {}) {
  // The hook uses select: (data) => (data.status === 200 ? data.data : null)
  // so the data value returned by the hook is already the transformed subscription object.
  // We simulate that by returning the subscription directly as data.
  mockUseGetSubscriptionStatus.mockReturnValue({
    data: subscription,
    isLoading,
    error: queryError,
    refetch: vi.fn(),
  });
  mockUseUpdateSubscriptionTier.mockReturnValue({
    mutateAsync: mutateFn,
    isPending,
    variables,
  });
}

afterEach(() => {
  cleanup();
  mockUseGetSubscriptionStatus.mockReset();
  mockUseUpdateSubscriptionTier.mockReset();
  mockToast.mockReset();
  // Reset search params
  mockSearchParams.delete("subscription");
});

describe("SubscriptionTierSection", () => {
  it("renders nothing while loading", () => {
    setupMocks({ isLoading: true });
    const { container } = render(<SubscriptionTierSection />);
    expect(container.innerHTML).toBe("");
  });

  it("renders error message when subscription fetch fails", () => {
    setupMocks({ queryError: new Error("Network error"), subscription: makeSubscription() });
    // Override the data to simulate failed state
    mockUseGetSubscriptionStatus.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error("Network error"),
      refetch: vi.fn(),
    });
    render(<SubscriptionTierSection />);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/failed to load subscription info/i)).toBeDefined();
  });

  it("renders all three tier cards for FREE user", () => {
    setupMocks();
    render(<SubscriptionTierSection />);
    // Use getAllByText to account for the tier label AND cost display both containing "Free"
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    expect(screen.getByText("Pro")).toBeDefined();
    expect(screen.getByText("Business")).toBeDefined();
  });

  it("shows Current badge on the active tier", () => {
    setupMocks({ subscription: makeSubscription({ tier: "PRO" }) });
    render(<SubscriptionTierSection />);
    expect(screen.getByText("Current")).toBeDefined();
    // Upgrade to PRO button should NOT exist; Upgrade to BUSINESS and Downgrade to Free should
    expect(screen.queryByRole("button", { name: /upgrade to pro/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /upgrade to business/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /downgrade to free/i }),
    ).toBeDefined();
  });

  it("displays tier costs from the API", () => {
    setupMocks({
      subscription: makeSubscription({
        tier: "FREE",
        tierCosts: { FREE: 0, PRO: 1999, BUSINESS: 4999, ENTERPRISE: 0 },
      }),
    });
    render(<SubscriptionTierSection />);
    expect(screen.getByText("$19.99/mo")).toBeDefined();
    expect(screen.getByText("$49.99/mo")).toBeDefined();
    // FREE tier label should still be visible (there may be multiple "Free" elements)
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
  });

  it("shows 'Pricing available soon' when tier cost is 0 for a paid tier", () => {
    setupMocks({
      subscription: makeSubscription({
        tier: "FREE",
        tierCosts: { FREE: 0, PRO: 0, BUSINESS: 0, ENTERPRISE: 0 },
      }),
    });
    render(<SubscriptionTierSection />);
    // PRO and BUSINESS with cost=0 should show "Pricing available soon"
    expect(screen.getAllByText("Pricing available soon")).toHaveLength(2);
  });

  it("calls changeTier on upgrade click without confirmation", async () => {
    const mutateFn = vi
      .fn()
      .mockResolvedValue({ status: 200, data: { url: "" } });
    setupMocks({ mutateFn });
    render(<SubscriptionTierSection />);

    fireEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));

    await waitFor(() => {
      expect(mutateFn).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ tier: "PRO" }) }),
      );
    });
  });

  it("shows confirmation dialog on downgrade click", () => {
    setupMocks({ subscription: makeSubscription({ tier: "PRO" }) });
    render(<SubscriptionTierSection />);

    fireEvent.click(screen.getByRole("button", { name: /downgrade to free/i }));

    expect(screen.getByRole("dialog")).toBeDefined();
    // The dialog title text appears in both a div and a button — just check the dialog is open
    expect(screen.getAllByText(/confirm downgrade/i).length).toBeGreaterThan(0);
  });

  it("calls changeTier after downgrade confirmation", async () => {
    const mutateFn = vi
      .fn()
      .mockResolvedValue({ status: 200, data: { url: "" } });
    setupMocks({
      subscription: makeSubscription({ tier: "PRO" }),
      mutateFn,
    });
    render(<SubscriptionTierSection />);

    fireEvent.click(screen.getByRole("button", { name: /downgrade to free/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm downgrade/i }));

    await waitFor(() => {
      expect(mutateFn).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ tier: "FREE" }) }),
      );
    });
  });

  it("dismisses dialog when Cancel is clicked", () => {
    setupMocks({ subscription: makeSubscription({ tier: "PRO" }) });
    render(<SubscriptionTierSection />);

    fireEvent.click(screen.getByRole("button", { name: /downgrade to free/i }));
    expect(screen.getByRole("dialog")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("redirects to Stripe when checkout URL is returned", async () => {
    const originalLocation = window.location;
    // @ts-expect-error – jsdom location is not writable; cast for test purposes
    delete window.location;
    window.location = { ...originalLocation, href: "" } as Location;

    const mutateFn = vi.fn().mockResolvedValue({
      status: 200,
      data: { url: "https://checkout.stripe.com/pay/cs_test" },
    });
    setupMocks({ mutateFn });
    render(<SubscriptionTierSection />);

    fireEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/pay/cs_test",
      );
    });

    window.location = originalLocation;
  });

  it("shows an error alert when tier change fails", async () => {
    const mutateFn = vi.fn().mockRejectedValue(new Error("Stripe unavailable"));
    setupMocks({ mutateFn });
    render(<SubscriptionTierSection />);

    fireEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
      expect(screen.getByText(/stripe unavailable/i)).toBeDefined();
    });
  });

  it("shows ENTERPRISE message for ENTERPRISE tier users", () => {
    setupMocks({ subscription: makeSubscription({ tier: "ENTERPRISE" }) });
    render(<SubscriptionTierSection />);
    // Enterprise heading text appears in a <p> (may match multiple), just verify it exists
    expect(screen.getAllByText(/enterprise plan/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/managed by your administrator/i)).toBeDefined();
    // No standard tier cards should be rendered
    expect(screen.queryByText("Pro")).toBeNull();
    expect(screen.queryByText("Business")).toBeNull();
  });
});
