import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  ClerkProvider,
  Show,
  SignIn,
  SignUp,
  useAuth,
  useClerk,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { ptBR } from "@clerk/localizations";
import { shadcn } from "@clerk/themes";
import {
  Redirect,
  Route,
  Router as WouterRouter,
  Switch,
  useLocation,
} from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY.");
}

const appearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside",
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#16a34a",
    colorForeground: "#111827",
    colorMutedForeground: "#6b7280",
    colorDanger: "#dc2626",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "#111827",
    colorNeutral: "#d1d5db",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    borderRadius: "14px",
  },
  elements: {
    rootBox: {
      width: "100%",
      minWidth: 0,
      display: "flex",
      justifyContent: "center",
    },
    cardBox: {
      width: "100%",
      maxWidth: "440px",
      minWidth: 0,
      boxSizing: "border-box",
      overflow: "hidden",
      borderRadius: "18px",
      backgroundColor: "#ffffff",
      boxShadow: "0 10px 30px #00000012",
    },
    card: { border: "0", boxShadow: "none", backgroundColor: "transparent" },
    footer: { border: "0", boxShadow: "none", backgroundColor: "transparent" },
    headerTitle: { color: "#111827", fontWeight: "800" },
    headerSubtitle: { color: "#6b7280" },
    socialButtonsBlockButtonText: { color: "#111827", fontWeight: "600" },
    formFieldLabel: { color: "#374151", fontWeight: "600" },
    footerActionLink: { color: "#15803d", fontWeight: "700" },
    footerActionText: { color: "#6b7280" },
    dividerText: { color: "#6b7280" },
    formButtonPrimary: { backgroundColor: "#16a34a", color: "#ffffff" },
    formFieldInput: {
      backgroundColor: "#ffffff",
      color: "#111827",
      borderColor: "#d1d5db",
    },
    alertText: { color: "#991b1b" },
  },
};

function PublicHome() {
  const [, setLocation] = useLocation();
  return (
    <main className="auth-page">
      <section className="card auth-card">
        <div className="welcome-icon" aria-hidden="true">
          🏭
        </div>
        <h1>Controle de Produção</h1>
        <p className="note">
          Entre para registrar os dois períodos de produção e consultar o
          histórico de qualquer dia.
        </p>
        <div className="auth-actions">
          <button
            className="big plus"
            type="button"
            onClick={() => setLocation("/sign-in")}
          >
            ENTRAR E INICIAR
          </button>
          <button
            className="small auth-secondary"
            type="button"
            onClick={() => setLocation("/sign-up")}
          >
            Criar minha conta
          </button>
        </div>
      </section>
    </main>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/user-portal" />
      </Show>
      <Show when="signed-out">
        <PublicHome />
      </Show>
    </>
  );
}

function UserPortal() {
  const { isLoaded, isSignedIn, userId } = useAuth();

  useEffect(() => {
    const content = document.getElementById("appContent");
    const activeUserId = isLoaded && isSignedIn ? userId : null;
    if (!activeUserId) {
      content?.classList.add("hidden");
      if (window.productionAuthUserId) {
        window.productionAuthUserId = null;
        window.dispatchEvent(new CustomEvent("production-auth-cleared"));
      }
      return;
    }

    content?.classList.remove("hidden");
    if (window.productionAuthUserId !== activeUserId) {
      window.productionAuthUserId = activeUserId;
      window.dispatchEvent(
        new CustomEvent("production-auth-ready", {
          detail: { userId: activeUserId },
        }),
      );
    }
    return () => {
      if (window.productionAuthUserId === activeUserId) {
        document.getElementById("appContent")?.classList.add("hidden");
        window.productionAuthUserId = null;
        window.dispatchEvent(new CustomEvent("production-auth-cleared"));
      }
    };
  }, [isLoaded, isSignedIn, userId]);

  if (!isLoaded) {
    return <main className="auth-page"><p>Carregando...</p></main>;
  }
  if (!isSignedIn) return <Redirect to="/" />;
  return null;
}

function SignInPage() {
  return (
    <main className="auth-page">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </main>
  );
}

function SignUpPage() {
  return (
    <main className="auth-page">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </main>
  );
}

function HeaderAuthControl() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const target = document.getElementById("authControls");
  if (!target || !isLoaded || !isSignedIn) return null;

  return createPortal(
    <button
      className="header-home"
      type="button"
      onClick={() => signOut({ redirectUrl: basePath || "/" })}
    >
      Sair
    </button>,
    target,
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={appearance}
      localization={ptBR}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) =>
        setLocation(basePath && to.startsWith(basePath) ? to.slice(basePath.length) || "/" : to)
      }
      routerReplace={(to) =>
        setLocation(
          basePath && to.startsWith(basePath) ? to.slice(basePath.length) || "/" : to,
          { replace: true },
        )
      }
    >
      <HeaderAuthControl />
      <Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/user-portal" component={UserPortal} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

createRoot(document.getElementById("auth-root")).render(<App />);