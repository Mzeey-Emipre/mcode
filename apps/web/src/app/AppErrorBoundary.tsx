import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Props for the application-wide crash recovery boundary. */
interface AppErrorBoundaryProps {
  children: ReactNode;
  onReload?: () => void;
}

/** Prevents descendant render failures from unmounting the application root. */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: true } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AppErrorBoundary] Caught application render error", error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center text-foreground">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">Mcode ran into a problem</h1>
            <p className="text-sm text-muted-foreground">
              Reload the app to continue.
            </p>
          </div>
          <Button onClick={this.props.onReload ?? (() => window.location.reload())}>
            Reload Mcode
          </Button>
        </main>
      );
    }

    return this.props.children;
  }
}
