// Bilingual dictionary. Both languages ship in v1.
export type Lang = "en" | "fr";

const dict: Record<string, { en: string; fr: string }> = {
  // No version here. It used to read "v0.1.7" and it was still reading it in
  // the 0.1.9 build, because a version written into a translation string is
  // updated by remembering to, and nobody did for two releases. The sidebar
  // now appends the version the BINARY reports, which is the same source the
  // updater compares against.
  "brand.by": { en: "by Noxalis Lab", fr: "par Noxalis Lab" },
  "tools.blocked": {
    en: "This model does not emit tool calls, so the agent cannot read files or run commands. Start a model that does.",
    fr: "Ce modèle n'emet pas d'appels d'outils : l'agent ne peut ni lire de fichier ni lancer de commande. Demarre un modèle qui le fait.",
  },
  "tools.blockedShort": { en: "no tool calls", fr: "pas d'appels d'outils" },
  "tools.forcedManual": {
    en: "Manual only: this model does not emit tool calls.",
    fr: "Manuel uniquement : ce modèle n'emet pas d'appels d'outils.",
  },
  "net.copy": { en: "Copy", fr: "Copier" },
  "net.forClient": { en: "Ready to paste", fr: "Prêt à coller" },
  "net.needOpen": {
    en: "Open the relay to get the settings for your tools.",
    fr: "Ouvre le relais pour obtenir les réglages de tes outils.",
  },
  "nav.server": { en: "Server", fr: "Serveur" },
  "sect.network": { en: "Network", fr: "Réseau" },
  "sect.networkHint": {
    en: "Serve the running model to other apps and other machines",
    fr: "Servir le modèle en cours à d'autres apps et d'autres machines",
  },
  "common.on": { en: "On", fr: "Oui" },
  "common.off": { en: "Off", fr: "Non" },
  "mode.title": { en: "How should Galactus start?", fr: "Comment démarrer Galactus ?" },
  "mode.body": {
    en: "This decides which half of the app exists. You can change it later in Settings.",
    fr: "Ce choix décide quelle moitié de l'app existe. Il se change ensuite dans les Réglages.",
  },
  "mode.appBody": {
    en: "The full assistant, on this Mac.",
    fr: "L'assistant complet, sur ce Mac.",
  },
  "mode.appA": { en: "Chat, workspace, memory, teammates", fr: "Chat, atelier, mémoire, équipiers" },
  "mode.appB": { en: "The model stays on 127.0.0.1", fr: "Le modèle reste sur 127.0.0.1" },
  "mode.appC": { en: "Everything below is available too", fr: "Tout ce qui suit reste disponible" },
  "mode.serverBody": {
    en: "Serve the model to your other tools, and to other machines.",
    fr: "Servir le modèle à tes autres outils, et à d'autres machines.",
  },
  "mode.serverA": { en: "Models, connectors, settings, runs", fr: "Modèles, connecteurs, réglages, runs" },
  "mode.serverB": {
    en: "Authenticating relay, reachable from your network",
    fr: "Relais authentifie, joignable depuis ton réseau",
  },
  "mode.serverC": {
    en: "No surface that reads your files",
    fr: "Aucune surface qui lit tes fichiers",
  },
  "mode.askAlways": { en: "Ask again every launch", fr: "Redemander à chaque lancement" },
  "net.modeAsk": { en: "Ask at launch", fr: "Demander au lancement" },
  "net.modeAskHint": {
    en: "Show the two doors at every start instead of reopening in the last mode.",
    fr: "Montrer les deux portes a chaque demarrage au lieu de rouvrir dans le dernier mode.",
  },
  "net.mode": { en: "App mode", fr: "Mode de l'app" },
  "net.modeHint": {
    en: "Server mode keeps the model, the settings and the measurements, and hides the assistant surfaces.",
    fr: "Le mode serveur garde le modèle, les réglages et les mesures, et masque les surfaces d'assistant.",
  },
  "net.modeApp": { en: "Assistant", fr: "Assistant" },
  "net.modeServer": { en: "Server", fr: "Serveur" },
  "net.expose": { en: "Reachable from", fr: "Joignable depuis" },
  "net.exposeHint": {
    en: "This Mac only, or every machine on your network. The engine itself never leaves 127.0.0.1: an authenticating relay is what listens.",
    fr: "Ce Mac seulement, ou toute machine de ton réseau. Le moteur lui-meme ne quitte jamais 127.0.0.1 : c'est un relais authentifie qui ecoute.",
  },
  "net.localOnly": { en: "This Mac", fr: "Ce Mac" },
  "net.network": { en: "My network", fr: "Mon réseau" },
  "net.key": { en: "API key", fr: "Cle d'API" },
  "net.keyHint": {
    en: "Required. Shown once, right here, and never stored in clear: copy it now.",
    fr: "Obligatoire. Affichee une seule fois, ici meme, et jamais stockee en clair : copie-la maintenant.",
  },
  "net.newKey": { en: "Generate", fr: "Generer" },
  "net.copied": { en: "copied", fr: "copiee" },
  "net.start": { en: "Open", fr: "Ouvrir" },
  "net.stop": { en: "Close", fr: "Fermer" },
  "net.needModel": { en: "Start a model first.", fr: "Demarre d'abord un modèle." },
  "net.needKey": { en: "Generate a key first.", fr: "Genere d'abord une cle." },
  "net.open": { en: "open on", fr: "ouvert sur" },
  "net.closed": { en: "closed", fr: "ferme" },
  "net.snippets": { en: "Connect another tool", fr: "Brancher un autre outil" },
  "net.snippetsHint": {
    en: "Any OpenAI-compatible client. Base URL, model name and key are below.",
    fr: "N'importe quel client compatible OpenAI. URL de base, nom du modèle et cle ci-dessous.",
  },
  "nav.chat": { en: "Chat", fr: "Discussion" },
  "nav.code": { en: "Code", fr: "Code" },
  "nav.models": { en: "Models", fr: "Modèles" },
  "nav.connectors": { en: "Connectors", fr: "Connecteurs" },
  "nav.runs": { en: "Runs", fr: "Runs" },
  "nav.memory": { en: "Memory", fr: "Mémoire" },
  "nav.agent": { en: "Agent", fr: "Agent" },
  "nav.settings": { en: "Settings", fr: "Réglages" },
  "layout.resizeSidebar": { en: "Resize the navigation sidebar", fr: "Redimensionner la barre de navigation" },
  "layout.resizeFiles": { en: "Resize the file explorer", fr: "Redimensionner l’explorateur de fichiers" },
  "layout.resizeAgent": { en: "Resize the agent pane", fr: "Redimensionner le panneau Agent" },
  "layout.resizePreview": { en: "Resize the preview", fr: "Redimensionner l’aperçu" },
  "layout.resizeHint": {
    en: "Left/Right arrows · Shift for 48 px · double-click to reset",
    fr: "Flèches gauche/droite · Maj pour 48 px · double-clic pour réinitialiser",
  },

  "chat.placeholder": { en: "Message Galactus… (⇧⏎ for a new line)", fr: "Écrire à Galactus… (⇧⏎ pour un saut de ligne)" },
  "chat.noserver": { en: "Start a model in Models to begin.", fr: "Démarre un modèle dans Modèles pour commencer." },
  "chat.queuedTag": { en: "waiting its turn", fr: "en attente de son tour" },
  "chat.you": { en: "You", fr: "Vous" },
  "chat.localHint": { en: "100% local · your Mac", fr: "100% local · ton Mac" },
  "chat.plan": { en: "Plan", fr: "Plan" },
  "chat.running": { en: "running…", fr: "en cours…" },
  "chat.done": { en: "done", fr: "terminé" },
  "auto.switched": { en: "Task detected: %s", fr: "Tâche détectée : %s" },
  "auto.swapping": { en: "Loading %s, better suited to this task…", fr: "Chargement de %s, mieux adapté à cette tâche…" },
  "auto.swapTimeout": { en: "The model took too long to load", fr: "Le modèle a mis trop de temps à charger" },
  "auto.title": { en: "Automatic model routing", fr: "Bascule automatique de modèle" },
  "auto.hint": {
    en: "Detects the task from your message. Persona changes are instant; a model reload takes time, so it is only automatic when the running model is unfit.",
    fr: "Détecte la tâche depuis ton message. Le changement de persona est instantané ; un rechargement de modèle prend du temps, il n'est donc automatique que si le modèle en cours est inadapté.",
  },
  "auto.off": { en: "Off", fr: "Désactivé" },
  "auto.ask": { en: "Suggest", fr: "Proposer" },
  "auto.auto": { en: "Automatic", fr: "Automatique" },
  "chat.copied": { en: "copied", fr: "copié" },
  "chat.empty": { en: "Ask anything: files, shell, code, writing.", fr: "Demande ce que tu veux : fichiers, shell, code, rédaction." },
  "chat.revert": { en: "Undo this change", fr: "Annuler cette modification" },
  "chat.reverted": { en: "reverted", fr: "annulé" },
  "chat.revertFail": { en: "no backup", fr: "pas de sauvegarde" },
  "chat.fromAgent": { en: "from « %s »", fr: "de « %s »" },
  "conv.recent": { en: "CONVERSATIONS", fr: "CONVERSATIONS" },
  "conv.untitled": { en: "New conversation", fr: "Nouvelle discussion" },

  "mode.manual": { en: "Manual", fr: "Manuel" },
  "mode.assisted": { en: "Assisted", fr: "Assisté" },
  "mode.autonomous": { en: "Autonomous", fr: "Autonome" },

  "tool.read": { en: "Read file", fr: "Lire le fichier" },
  "tool.write": { en: "Write file", fr: "Écrire le fichier" },
  "tool.list": { en: "List folder", fr: "Lister le dossier" },
  "tool.run": { en: "Run command", fr: "Exécuter la commande" },
  "tool.remember": { en: "Remember", fr: "Mémoriser" },
  "tool.skill": { en: "Load skill", fr: "Charger le skill" },
  "tool.doc": { en: "Read document", fr: "Lire le document" },
  // run_workflow was replaced by the team; the label stays so conversations
  // stored by an earlier build still render their tool cards.
  "tool.workflow": { en: "Sub-agent workflow", fr: "Workflow de sous-agents" },
  "px.thinking": { en: "thinking", fr: "réfléchit" },
  "px.queued": { en: "waiting for a free slot", fr: "attend un créneau libre" },
  "px.responding": { en: "writing the reply", fr: "rédige la réponse" },
  // Distinct from px.thinking on purpose: "thinking" is what the app says
  // while it waits for a first token of anything, and this is what it says
  // once the model's own thoughts are actually arriving on screen.
  "px.reasoning": { en: "reasoning out loud", fr: "raisonne à voix haute" },
  "chat.reasoningTrimmed": {
    en: "(earlier thinking not kept)",
    fr: "(début de la réflexion non conservé)",
  },
  "chat.reasoning": { en: "Reasoning", fr: "Raisonnement" },
  "chat.reasoningLive": { en: "live", fr: "en direct" },
  "tool.osearch": { en: "Search vault", fr: "Chercher dans le coffre" },
  "tool.oread": { en: "Read note", fr: "Lire la note" },
  "tool.owrite": { en: "Write note", fr: "Écrire la note" },
  "tool.oupdate": { en: "Rewrite note", fr: "Réécrire la note" },
  "tool.spawnAgent": { en: "Recruit a sub-agent", fr: "Recruter un sous-agent" },
  "tool.listAgents": { en: "List the team", fr: "Lister l'équipe" },
  "tool.askAgent": { en: "Ask a teammate", fr: "Demander à un coéquipier" },
  "tool.convSearch": { en: "Search the conversations", fr: "Chercher dans les discussions" },
  "tool.convRead": { en: "Read a conversation", fr: "Lire une discussion" },

  "models.subtitle": { en: "Galactus execution policy · certification enforced", fr: "Politique d’exécution Galactus · certification appliquée" },
  "models.certified": { en: "certified", fr: "certifié" },
  "models.certComposition": { en: "certified by composition", fr: "certifié par composition" },
  "models.certStock": { en: "stock, not accelerated", fr: "d'origine, non accéléré" },
  "models.certStockNote": {
    en: "A dense model: it has no experts to stream, so the SSD engine does not apply. It runs through unmodified llama.cpp and has to fit in memory like anywhere else.",
    fr: "Modèle dense : aucun expert à diffuser, le moteur SSD ne s'applique donc pas. Il passe par llama.cpp non modifié et doit tenir en mémoire comme partout ailleurs.",
  },
  "models.certPending": { en: "validation in progress", fr: "validation en cours" },
  "models.certBlocked": { en: "not certified", fr: "non certifié" },
  "models.certPendingNote": {
    en: "Installation and execution are locked until Galactus validation is complete.",
    fr: "Installation et exécution verrouillées jusqu’à la fin de la validation Galactus.",
  },
  "models.certBlockedNote": {
    en: "Installation and execution are locked: this registry status is not certified.",
    fr: "Installation et exécution verrouillées : ce statut du registre n’est pas certifié.",
  },
  "models.noneCompatible": { en: "No model is compatible with this Mac", fr: "Aucun modèle compatible avec ce Mac" },
  "models.noneCompatibleHint": {
    en: "Galactus will not offer a download that this hardware cannot run.",
    fr: "Galactus ne propose aucun téléchargement que ce matériel ne peut pas exécuter.",
  },
  "models.unavailable": { en: "%n unavailable models", fr: "%n modèles indisponibles" },
  "models.incompatible": { en: "incompatible hardware", fr: "matériel incompatible" },
  "models.onThisMac": { en: "on this Mac", fr: "sur ce Mac" },
  "models.download": { en: "Install", fr: "Installer" },
  "models.manualInstall": {
    en: "No verified download source · manual import only",
    fr: "Aucune source de téléchargement vérifiée · import manuel uniquement",
  },
  "models.start": { en: "Start", fr: "Démarrer" },
  "models.stop": { en: "Stop", fr: "Arrêter" },
  "models.installed": { en: "Installed", fr: "Installé" },
  "models.tooSmall": { en: "Below the minimum for this Mac", fr: "Sous le minimum pour ce Mac" },
  "models.nativeFit": {
    en: "Fully cache-resident on this Mac, bit-exact",
    fr: "Résidence totale en cache sur ce Mac, bit-exact",
  },
  "engine.resident": {
    en: "Galactus engine: every expert cache-resident, bit-exact (certified numerics)",
    fr: "Moteur Galactus : tous les experts résidents en cache, bit-exact (numérique certifiée)",
  },
  "engine.streamed": {
    en: "Galactus engine: experts streamed from SSD, bit-exact (certified numerics)",
    fr: "Moteur Galactus : experts streamés du SSD, bit-exact (numérique certifiée)",
  },
  "engine.cpu": {
    en: "Galactus engine: CPU experts, bit-exact cross-check regime (certified numerics)",
    fr: "Moteur Galactus : experts CPU, régime de contre-vérification bit-exact (numérique certifiée)",
  },
  "engine.residentShort": { en: "resident", fr: "résident" },
  "load.title": { en: "Loading %m", fr: "Chargement de %m" },
  "load.hint": {
    en: "The expert cache is warming up; the first load is the longest.",
    fr: "Le cache d'experts se remplit ; le premier chargement est le plus long.",
  },
  "load.elapsed": { en: "%s elapsed", fr: "%s écoulées" },
  "live.ram": { en: "Engine resident memory, live", fr: "Mémoire résidente du moteur, en direct" },
  "live.tps": { en: "Generation speed, live (chars / 4 per second)", fr: "Vitesse de génération en direct (caractères / 4 par seconde)" },
  "live.threads": { en: "threads", fr: "fils" },
  "live.threadsHint": {
    en: "Threads with a turn in flight. The engine decodes %n at a time; a teammate waiting on another one is in flight without decoding.",
    fr: "Fils dont un tour est en cours. Le moteur décode %n à la fois ; un coéquipier qui en attend un autre est en cours sans décoder.",
  },
  "models.hwNote": {
    en: "Speeds are estimated for this Mac from measured benchmarks.",
    fr: "Vitesses estimées pour ce Mac à partir de mesures réelles.",
  },

  "hw.chip": { en: "Chip", fr: "Puce" },
  "hw.ram": { en: "Memory", fr: "Mémoire" },
  "hw.disk": { en: "Disk free", fr: "Disque libre" },
  "hw.gpu": { en: "Graphics", fr: "Graphismes" },
  "hw.gpuCores": { en: "%n cores", fr: "%n cœurs" },
  "hw.budget": { en: "For models", fr: "Pour les modèles" },
  "hw.budgetHint": {
    en: "The most Galactus will hold in memory at once on this Mac right now.",
    fr: "Ce que Galactus gardera au plus en mémoire sur ce Mac en ce moment.",
  },
  "hw.bandwidth": { en: "Memory speed", fr: "Vitesse mémoire" },
  "hw.onBattery": {
    en: "On battery: speeds are lower than the figures below until you plug in.",
    fr: "Sur batterie : les vitesses restent sous les chiffres ci-dessous tant que le Mac n'est pas branché.",
  },

  // The one sentence that says what the app chose for a model on this Mac.
  // Placeholders are named because a translation may reorder them: %m mode,
  // %q mode asked for, %n conversations, %r footprint in GB, %b what the Mac
  // can spare in GB.
  "brief.ok": {
    en: "Set up for your Mac: %m, %n conversation(s) at a time, using about %r GB of the %b GB available.",
    fr: "Réglé pour votre Mac : %m, %n discussion(s) à la fois, environ %r Go sur les %b Go disponibles.",
  },
  "brief.adjusted": {
    en: "Your Mac has %b GB free right now, not enough for %q, so Galactus will run this model in %m (about %r GB).",
    fr: "Votre Mac a %b Go de libre en ce moment, pas assez pour %q, donc Galactus lancera ce modèle en %m (environ %r Go).",
  },
  "brief.blocked": {
    en: "Not enough free memory for this model right now: it needs about %r GB and your Mac can spare %b GB. Quit an application and try again.",
    fr: "Pas assez de mémoire libre pour ce modèle en ce moment : il lui faut environ %r Go et votre Mac peut en libérer %b. Quittez une application puis réessayez.",
  },
  "brief.layoutSingle": {
    en: "It will be stored on one drive.",
    fr: "Il sera stocké sur un seul disque.",
  },
  "brief.layoutDual": {
    en: "It will be spread over both drives and read from both at once, which is faster.",
    fr: "Il sera réparti sur les deux disques et lu sur les deux à la fois, ce qui est plus rapide.",
  },
  "brief.layoutNoRoom": {
    en: "No drive has room for it. Free some space, or connect another drive.",
    fr: "Aucun disque n'a la place. Libérez de l'espace, ou branchez un autre disque.",
  },
  "brief.override": { en: "Change", fr: "Modifier" },
  "brief.auto": { en: "Automatic", fr: "Automatique" },
  "brief.autoHint": {
    en: "Galactus picks the number this Mac can afford, per model.",
    fr: "Galactus choisit le nombre que ce Mac peut se permettre, modèle par modèle.",
  },

  "conn.subtitle": { en: "Give Galactus new abilities", fr: "De nouvelles capacités pour Galactus" },
  "conn.choose": { en: "Choose…", fr: "Choisir…" },
  "conn.custom": { en: "Add a custom connector", fr: "Ajouter un connecteur personnalisé" },
  "conn.customTitle": { en: "Custom connector", fr: "Connecteur personnalisé" },
  "conn.customName": { en: "Name", fr: "Nom" },
  "conn.customCommand": { en: "Command", fr: "Commande" },
  "conn.customArgs": { en: "Arguments", fr: "Arguments" },
  "conn.add": { en: "Add", fr: "Ajouter" },
  "conn.cancel": { en: "Cancel", fr: "Annuler" },
  "conn.connected": { en: "%s connected", fr: "%s connecté" },
  "conn.failed": { en: "Connector failed: %s", fr: "Échec du connecteur : %s" },

  "mem.subtitle": { en: "What Galactus keeps in mind", fr: "Ce que Galactus garde en tête" },
  "mem.enable": { en: "Persistent memory", fr: "Mémoire persistante" },
  "mem.enableHint": {
    en: "Remembers lasting facts about you across conversations.",
    fr: "Retient des faits durables sur toi d'une discussion à l'autre.",
  },
  "mem.scope": { en: "Scope", fr: "Portée" },
  "mem.scopeGlobal": { en: "Global", fr: "Globale" },
  "mem.scopeWorkspace": { en: "Workspace", fr: "Dossier" },
  "mem.scopeGlobalHint": { en: "Follows you everywhere.", fr: "Te suit partout." },
  "mem.workspaceNone": { en: "No workspace set", fr: "Aucun dossier défini" },
  "mem.change": { en: "Change", fr: "Changer" },
  "mem.content": { en: "WHAT IT REMEMBERS", fr: "CE DONT IL SE SOUVIENT" },
  "mem.save": { en: "Save", fr: "Enregistrer" },
  "mem.saved": { en: "Saved ✓", fr: "Enregistré ✓" },
  "mem.vaultNone": { en: "Connect a vault to read and write notes", fr: "Connecte un coffre pour lire et écrire des notes" },
  "mem.chooseVault": { en: "Choose vault", fr: "Choisir le coffre" },
  "mem.cosmos": { en: "Constellation", fr: "Constellation" },
  "mem.newVault": { en: "New vault", fr: "Créer un coffre" },
  "mem.vaultCreated": { en: "Vault created and connected", fr: "Coffre créé et connecté" },
  "cosmos.save": { en: "Save", fr: "Enregistrer" },
  "cosmos.saved": { en: "%s saved", fr: "%s enregistrée" },
  "cosmos.title": { en: "Constellation", fr: "Constellation" },
  "cosmos.sub": { en: "%n notes · %e links", fr: "%n notes · %e liens" },
  "cosmos.hint": {
    en: "Drag to orbit · scroll to zoom · double-click to resume the spin",
    fr: "Glisse pour orbiter · molette pour zoomer · double-clic pour relancer la rotation",
  },
  "cosmos.empty": { en: "No notes found in the vault.", fr: "Aucune note trouvée dans le coffre." },

  "agent.subtitle": { en: "Workspace, autonomy and skills", fr: "Dossier, autonomie et skills" },
  "agent.workspaceTitle": { en: "Working folder", fr: "Dossier de travail" },
  "agent.workspaceDesc": {
    en: "The folder the agent focuses on. Enables workspace memory and skills.",
    fr: "Le dossier sur lequel l'agent se concentre. Active la mémoire et les skills du dossier.",
  },
  "agent.workspaceNone": { en: "No folder selected", fr: "Aucun dossier sélectionné" },
  "agent.autonomyTitle": { en: "Autonomy", fr: "Autonomie" },
  "agent.autonomyDesc": {
    en: "How far Galactus goes on its own. System actions always ask.",
    fr: "Jusqu'où Galactus va seul. Les actions système demandent toujours.",
  },
  "agent.manualDesc": { en: "Asks before every action.", fr: "Demande avant chaque action." },
  "agent.assistedDesc": { en: "Plans and acts, asks to touch anything.", fr: "Planifie et agit, demande pour toute action." },
  "agent.autonomousDesc": { en: "Runs the whole task; only system actions ask.", fr: "Mène toute la tâche ; seules les actions système demandent." },
  "agent.skillsDesc": {
    en: "Packaged instructions loaded on demand. Toggle which are available.",
    fr: "Instructions packagées chargées à la demande. Choisis lesquelles sont disponibles.",
  },
  "agent.doneNotify": { en: "Task finished", fr: "Tâche terminée" },

  "agent.engineStopped": {
    en: "the engine was stopped",
    fr: "le moteur a été arrêté",
  },
  "agent.skillsEmpty": {
    en: "No skills yet. Add a folder with a SKILL.md in the working folder's .galactus/skills.",
    fr: "Aucun skill. Ajoute un dossier avec un SKILL.md dans .galactus/skills du dossier de travail.",
  },

  "perm.title": { en: "Permission request", fr: "Demande de permission" },
  "perm.sub": { en: "Galactus wants to:", fr: "Galactus souhaite :" },
  "perm.readFile": { en: "Read a file", fr: "Lire un fichier" },
  "perm.writeFile": { en: "Write a file", fr: "Écrire un fichier" },
  "perm.listDir": { en: "List a folder", fr: "Lister un dossier" },
  "perm.runCommand": { en: "Run a command", fr: "Exécuter une commande" },
  "perm.obsidian": { en: "Access your vault", fr: "Accéder à ton coffre" },
  "perm.mcpTool": { en: "Use a connector", fr: "Utiliser un connecteur" },
  "perm.memory": { en: "Save to persistent memory", fr: "Écrire dans la mémoire persistante" },
  "perm.web": { en: "Fetch a web page", fr: "Consulter une page web" },
  "perm.agent": { en: "Work with a sub-agent", fr: "Travailler avec un sous-agent" },
  "perm.conversations": { en: "Read your stored conversations", fr: "Lire tes discussions enregistrées" },
  "perm.origin": { en: "Asked by « %s »", fr: "Demandé par « %s »" },
  "perm.more": { en: "%n more waiting", fr: "%n autre(s) en attente" },
  "perm.waiting": { en: "waiting for your answer", fr: "en attente de ta réponse" },
  "tool.web": { en: "Fetch URL", fr: "Consulter l'URL" },
  "tool.kb": { en: "Search knowledge", fr: "Chercher dans les connaissances" },

  // knowledge folders
  "kb.title": { en: "Knowledge", fr: "Connaissances" },
  "kb.hint": {
    en: "Local folders indexed for search. The model looks things up there before answering.",
    fr: "Dossiers locaux indexés pour la recherche. Le modèle y puise avant de répondre.",
  },
  "kb.add": { en: "Add a folder", fr: "Ajouter un dossier" },
  "kb.reindex": { en: "Reindex", fr: "Réindexer" },
  "kb.reindexing": { en: "Indexing…", fr: "Indexation…" },
  "kb.stats": { en: "%f files · %c chunks", fr: "%f fichiers · %c fragments" },
  "kb.empty": { en: "No folder yet.", fr: "Aucun dossier pour l'instant." },
  "kb.done": { en: "Indexed: %f files, %c chunks", fr: "Indexé : %f fichiers, %c fragments" },
  "perm.allowOnce": { en: "Allow once", fr: "Autoriser une fois" },
  "perm.allowAlways": { en: "Always", fr: "Toujours" },
  "perm.deny": { en: "Deny", fr: "Refuser" },
  "perm.elevated": { en: "This can modify your system. Type ALLOW to confirm.", fr: "Ceci peut modifier ton système. Tape ALLOW pour confirmer." },
  "perm.elevatedPlaceholder": { en: "Type ALLOW", fr: "Tape ALLOW" },

  "settings.language": { en: "Language", fr: "Langue" },
  "common.ready": { en: "Ready", fr: "Prêt" },
  "settings.languageDesc": { en: "Interface language", fr: "Langue de l'interface" },
  "settings.folder": { en: "Galactus folder", fr: "Dossier Galactus" },
  "settings.cache": { en: "Expert cache", fr: "Cache experts" },
  "settings.cacheHint": { en: "Sized automatically for this Mac", fr: "Dimensionné automatiquement pour ce Mac" },
  "settings.auto": { en: "Auto", fr: "Auto" },
  "settings.ram": { en: "Memory footprint", fr: "Empreinte mémoire" },
  "settings.ramHint": {
    en: "How much RAM the expert cache takes. Eco streams more from SSD and frees the machine; Performance caches the most.",
    fr: "Combien de RAM prend le cache d'experts. Éco streame plus depuis le SSD et libère la machine ; Performance met le maximum en cache.",
  },
  "settings.slots": { en: "Simultaneous conversations", fr: "Discussions simultanées" },
  "settings.slotsHint": {
    en: "How many conversations may generate at the same time. Each slot keeps a full 8192-token window and costs about 0.8 GB of memory; beyond that, turns wait their turn.",
    fr: "Combien de discussions peuvent générer en même temps. Chaque créneau garde une fenêtre complète de 8192 jetons et coûte environ 0,8 Go de mémoire ; au-delà, les tours attendent leur place.",
  },
  "settings.slotsRestart": {
    en: "Applied the next time a model starts.",
    fr: "Pris en compte au prochain démarrage d'un modèle.",
  },
  "settings.ramEco": { en: "Eco", fr: "Éco" },
  "settings.ramBalanced": { en: "Balanced", fr: "Équilibré" },
  "settings.ramPerf": { en: "Performance", fr: "Performance" },
  "settings.api": { en: "Local API (OpenAI-compatible)", fr: "API locale (compatible OpenAI)" },
  "settings.apiHint": {
    en: "The running model serves this endpoint on your Mac only. Point Cursor, Claude Code, aider or any OpenAI client at it.",
    fr: "Le modèle en cours sert ce point d'accès sur ton Mac uniquement. Branche Cursor, Claude Code, aider ou tout client OpenAI dessus.",
  },
  "settings.apiCopy": { en: "Copy URL", fr: "Copier l'URL" },
  "settings.apiCopied": { en: "Copied ✓", fr: "Copiée ✓" },
  "settings.apiOff": { en: "Start a model to activate it", fr: "Démarre un modèle pour l'activer" },
  "settings.permissions": { en: "Standing permissions", fr: "Permissions permanentes" },
  "settings.permissionsHint": { en: "Rules you chose to always allow", fr: "Règles que tu as choisi d'autoriser toujours" },
  "settings.permissionsClear": { en: "Revoke all", fr: "Tout révoquer" },
  "settings.permissionsCleared": { en: "Revoked ✓", fr: "Révoquées ✓" },

  "onboard.title": { en: "Welcome to Galactus", fr: "Bienvenue dans Galactus" },
  "onboard.body": {
    en: "Galactus runs large open models locally, on this Mac. Point it at your Galactus folder to begin.",
    fr: "Galactus fait tourner de grands modèles ouverts localement, sur ce Mac. Indique ton dossier Galactus pour commencer.",
  },
  "onboard.detecting": { en: "Looking for your Galactus folder…", fr: "Recherche de ton dossier Galactus…" },
  "onboard.detected": { en: "Galactus folder found", fr: "Dossier Galactus trouvé" },
  "onboard.notfound": { en: "Not found automatically. Choose it below", fr: "Introuvable automatiquement. Choisis-le ci-dessous" },
  "onboard.use": { en: "Use this folder", fr: "Utiliser ce dossier" },
  "onboard.choose": { en: "Choose a folder", fr: "Choisir un dossier" },

  "server.label": { en: "Local server", fr: "Serveur local" },
  "server.starting": { en: "Starting…", fr: "Démarrage…" },
  "server.ready": { en: "Ready", fr: "Prêt" },
  "server.stopped": { en: "No model running", fr: "Aucun modèle" },
  "server.failed": { en: "Failed", fr: "Échec" },
  "server.timeout": { en: "Timed out", fr: "Délai dépassé" },
  "common.choose": { en: "Choose…", fr: "Choisir…" },
  "common.close": { en: "Close", fr: "Fermer" },

  "srvfail.title": { en: "The local server failed to start", fr: "Le serveur local n'a pas démarré" },
  "srvfail.timeoutTitle": { en: "The local server is not responding (timed out)", fr: "Le serveur local ne répond pas (délai dépassé)" },
  "srvfail.body": {
    en: "Last lines of the server log:",
    fr: "Dernières lignes du journal du serveur :",
  },
  "srvfail.copy": { en: "Copy log", fr: "Copier le log" },
  "srvfail.copied": { en: "Copied ✓", fr: "Copié ✓" },
  "srvfail.viewLog": { en: "View full log", fr: "Voir le journal complet" },
  "srvfail.logTitle": { en: "Server log", fr: "Journal du serveur" },
  "srvfail.loading": { en: "Loading…", fr: "Chargement…" },
  "srvfail.emptyLog": { en: "The log is empty.", fr: "Le journal est vide." },
  "srvfail.memoryTitle": {
    en: "The local server ran out of memory while loading",
    fr: "Le serveur local a manqué de mémoire pendant le chargement",
  },
  "srvfail.memoryBody": {
    en: "Quit a few applications to free memory, then start the model again. If it keeps happening, set the memory footprint to Eco in Settings.",
    fr: "Quittez quelques applications pour libérer de la mémoire, puis redémarrez le modèle. Si cela se reproduit, réglez l'empreinte mémoire sur Éco dans les Réglages.",
  },

  // What replaces the engine's own "Compute error.", which names no cause and
  // sends the user guessing. %s is the footprint mode the engine is running in.
  "engfail.memoryStepDown": {
    en: "The engine ran out of memory while answering. It is running in %s; other applications have taken the memory it needed. Free some memory, or set the memory footprint to Eco in Settings and start the model again.",
    fr: "Le moteur a manqué de mémoire pendant la réponse. Il tourne en mode %s ; d'autres applications ont pris la mémoire dont il avait besoin. Libérez de la mémoire, ou réglez l'empreinte mémoire sur Éco dans les Réglages puis redémarrez le modèle.",
  },
  "engfail.memoryAtFloor": {
    en: "The engine ran out of memory while answering, and it is already running in its smallest footprint. Quit a few applications to free memory, then start the model again.",
    fr: "Le moteur a manqué de mémoire pendant la réponse, et il tourne déjà dans son empreinte la plus petite. Quittez quelques applications pour libérer de la mémoire, puis redémarrez le modèle.",
  },
  "engfail.context": {
    en: "This conversation has outgrown the model's context window. Start a new conversation, or remove some of the files and long outputs it is carrying.",
    fr: "Cette conversation a dépassé la fenêtre de contexte du modèle. Ouvrez une nouvelle conversation, ou retirez une partie des fichiers et des longues sorties qu'elle transporte.",
  },
  "engfail.evidence": { en: "Engine log: %s", fr: "Journal du moteur : %s" },

  // Said out loud at start: a user who picked Performance and silently got Eco
  // would rightly call that a bug. %a is the mode asked for, %m the one used,
  // %g the memory this Mac could actually spare.
  "footprint.steppedDown": {
    en: "Started in %m instead of %a: this Mac can spare %g GB right now, not enough for %a.",
    fr: "Démarré en %m au lieu de %a : ce Mac peut céder %g Go en ce moment, pas assez pour %a.",
  },

  "perm.newFile": { en: "new file", fr: "nouveau fichier" },
  "perm.changes": { en: "Proposed change", fr: "Modification proposée" },
  "diff.omitted": { en: "… %n more lines", fr: "… %n lignes de plus" },

  "chat.revertConfirm": {
    en: "Restore the previous version of this file?",
    fr: "Restaurer la version précédente de ce fichier ?",
  },

  "models.empty": { en: "No models found", fr: "Aucun modèle trouvé" },
  "models.emptyHint": {
    en: "Check the Galactus folder in Settings, then come back here.",
    fr: "Vérifie le dossier Galactus dans les Réglages, puis reviens ici.",
  },
  "conn.empty": { en: "No connectors available", fr: "Aucun connecteur disponible" },
  "conn.emptyHint": {
    en: "The catalog could not be loaded. Check your network and try again.",
    fr: "Le catalogue n'a pas pu être chargé. Vérifie ton réseau et réessaie.",
  },

  "install.failed": { en: "Install failed: %s", fr: "Échec de l'installation : %s" },
  "install.download": { en: "Downloading", fr: "Téléchargement" },
  "install.profiling": { en: "Profiling", fr: "Analyse du modèle" },
  "install.planning": { en: "Planning", fr: "Planification" },
  "install.building": { en: "Building pack", fr: "Construction du pack" },
  "install.pack": { en: "Pack", fr: "Pack" },
  "install.done": { en: "Done", fr: "Terminé" },
  "install.probing": { en: "Measuring SSD bandwidth", fr: "Mesure des débits SSD" },
  "install.dualOk": { en: "Dual pack", fr: "Double pack" },
  "install.dualFallback": { en: "Bottleneck, single SSD", fr: "Goulot, un seul SSD" },

  // install dialog (volume choice)
  "installdlg.title": { en: "Install %s", fr: "Installer %s" },
  "installdlg.hint": {
    en: "Choose where the expert pack lives. Two SSDs read in parallel add up their bandwidth.",
    fr: "Choisis où vit le pack d'experts. Deux SSD lus en parallèle additionnent leur bande passante.",
  },
  "installdlg.mono": { en: "Single SSD", fr: "Un seul SSD" },
  "installdlg.dual": { en: "Two SSDs", fr: "Deux SSD" },
  "installdlg.volume": { en: "SSD", fr: "SSD" },
  "installdlg.primary": { en: "Primary SSD (internal pack)", fr: "SSD principal (pack interne)" },
  "installdlg.secondary": { en: "Second SSD (external pack)", fr: "Second SSD (pack externe)" },
  "installdlg.free": { en: "%s GB free", fr: "%s Go libres" },
  "installdlg.singleInfo": {
    en: "The pack will be written to %s.",
    fr: "Le pack sera écrit sur %s.",
  },
  "installdlg.measure": { en: "Measure", fr: "Mesurer" },
  "installdlg.measuring": { en: "Measuring, about 10 s per SSD", fr: "Mesure en cours, environ 10 s par SSD" },
  "installdlg.measureFail": { en: "Measure failed: %s", fr: "Échec de la mesure : %s" },
  "installdlg.verdictOk": {
    en: "Balanced speeds: the dual pack will aggregate both SSDs.",
    fr: "Débits équilibrés : le double pack agrégera les deux SSD.",
  },
  "installdlg.verdictSlow": {
    en: "Bottleneck: the slow SSD would cap the pair. Install will fall back to the fast one alone.",
    fr: "Goulot : le SSD lent briderait la paire. L'installation retombera sur le rapide seul.",
  },
  "installdlg.noSpace": { en: "Not enough free space on %s", fr: "Espace insuffisant sur %s" },
  "installdlg.noVolume": {
    en: "No volume has enough free space for this model.",
    fr: "Aucun volume n'a assez d'espace libre pour ce modèle.",
  },
  "installdlg.install": { en: "Install", fr: "Installer" },
  "installdlg.cancel": { en: "Cancel", fr: "Annuler" },

  // model deletion
  "models.delete": { en: "Delete", fr: "Supprimer" },
  "models.deleteConfirm": { en: "Delete %s?", fr: "Supprimer %s ?" },
  "models.deleting": { en: "Deleting", fr: "Suppression" },
  "models.deleteFail": { en: "Delete failed: %s", fr: "Échec de la suppression : %s" },

  "nav.newchat": { en: "New conversation", fr: "Nouvelle discussion" },

  // code-block preview
  "chat.preview": { en: "Preview", fr: "Aperçu" },

  // voice
  "chat.mic": { en: "Dictate (on-device)", fr: "Dicter (sur l'appareil)" },
  "chat.micStop": { en: "Stop dictation", fr: "Arrêter la dictée" },
  "chat.speak": { en: "Read aloud", fr: "Lire à voix haute" },
  "voice.error": { en: "Dictation failed: %s", fr: "Échec de la dictée : %s" },
  "voice.denied": {
    en: "Microphone or speech recognition not authorized (System Settings > Privacy).",
    fr: "Micro ou reconnaissance vocale non autorisés (Réglages Système > Confidentialité).",
  },

  // bench
  "models.bench": { en: "Measure", fr: "Mesurer" },
  "models.benchRunning": { en: "Measuring…", fr: "Mesure…" },
  "models.benchDone": { en: "Measured on this Mac: %s tok/s", fr: "Mesuré sur ce Mac : %s tok/s" },
  "models.measured": { en: "measured, tok/s", fr: "mesuré, tok/s" },
  "models.benchReset": {
    en: "Clear the measurement and show the estimate again",
    fr: "Effacer la mesure et réafficher l'estimation",
  },
  "models.benchResetDone": { en: "Measurement cleared", fr: "Mesure effacée" },
  "models.benchResetFail": {
    en: "Could not clear the measurement: %s",
    fr: "Impossible d'effacer la mesure : %s",
  },

  // deep research
  "chat.deep": { en: "Deep research", fr: "Recherche approfondie" },
  "chat.deepHint": {
    en: "The next message runs a sourced multi-agent research workflow.",
    fr: "Le prochain message lance une recherche multi-agents sourcée.",
  },

  // @file and @symbol mentions (src/mentions.ts)
  "mention.hint": { en: "@ to attach a file or a symbol", fr: "@ pour joindre un fichier ou un symbole" },
  "mention.none": { en: "No file or symbol matches", fr: "Aucun fichier ni symbole ne correspond" },
  "mention.attached": {
    en: "%n item(s) attached, about %t tokens",
    fr: "%n élément(s) joint(s), environ %t tokens",
  },
  "mention.dropped": {
    en: "%n mention(s) could not be attached, see the end of the message",
    fr: "%n mention(s) n'ont pas pu être jointes, voir la fin du message",
  },

  // drag & drop
  "chat.dropHint": {
    en: "Path added. Ask Galactus to read the file.",
    fr: "Chemin ajouté. Demande à Galactus de lire le fichier.",
  },

  // conversation list extras
  "conv.search": { en: "Search…", fr: "Rechercher…" },
  "conv.export": { en: "Export as Markdown", fr: "Exporter en Markdown" },
  "conv.noMatch": { en: "No conversation found", fr: "Aucune discussion trouvée" },
  "conv.running": { en: "This conversation is generating", fr: "Cette discussion est en cours de génération" },
  "conv.queued": { en: "Messages waiting for the next turn", fr: "Messages en attente du prochain tour" },

  // ---- team of sub-agents ----
  "team.label": { en: "TEAM", fr: "ÉQUIPE" },
  "team.size": { en: "%n sub-agents in this conversation", fr: "%n sous-agents dans cette discussion" },
  "team.noRole": { en: "no role given", fr: "rôle non précisé" },
  "team.parentName": { en: "the conversation", fr: "la discussion" },
  "team.parentRole": { en: "the conversation's own agent", fr: "l'agent de la discussion" },
  "team.back": { en: "Back to the conversation", fr: "Retour à la discussion" },
  "team.brief": { en: "Brief", fr: "Consigne" },
  "team.openThread": { en: "Open its thread (%n)", fr: "Ouvrir son fil (%n)" },
  "team.failed": { en: "failed", fr: "échec" },
  "team.emptyThread": {
    en: "This sub-agent has not been asked anything yet.",
    fr: "Ce sous-agent n'a encore rien reçu.",
  },
  "team.placeholder": { en: "Write to %s directly…", fr: "Écrire directement à %s…" },
  "team.created": {
    en: "Sub-agent « %n » joined the team · %r",
    fr: "Le sous-agent « %n » rejoint l'équipe · %r",
  },

  // chat extras (export + live stats)
  "chatx.exportAssistant": { en: "Galactus", fr: "Galactus" },
  "chatx.exportTool": { en: "Tool", fr: "Outil" },
  "chatx.exportReasoning": { en: "Reasoning", fr: "Raisonnement" },
  "chatx.exportError": { en: "Error", fr: "Erreur" },
  "chatx.exportAgent": { en: "Sub-agent", fr: "Sous-agent" },
  "chatx.exportEmptyAgent": { en: "(nothing was asked of this sub-agent)", fr: "(rien n'a été demandé à ce sous-agent)" },
  "chatx.tokens": { en: "tokens", fr: "tokens" },
  "chatx.tokPerSec": { en: "tok/s", fr: "tok/s" },
  "chatx.context": { en: "context", fr: "contexte" },
  "chatx.estimated": {
    en: "Estimate: streamed characters ÷ 4 and elapsed time.",
    fr: "Estimation : caractères reçus ÷ 4 et temps écoulé.",
  },

  // task personas / model routing
  "task.title": { en: "Task", fr: "Tâche" },
  "task.switchTo": { en: "Switching model…", fr: "Bascule du modèle…" },
  "task.keepModel": { en: "model already loaded", fr: "modèle déjà chargé" },
  "task.noModel": { en: "no preferred model installed", fr: "aucun modèle préféré installé" },
  "task.better": {
    en: "This task works better with %m",
    fr: "Cette tâche marche mieux avec %m",
  },
  "task.switch": { en: "Switch", fr: "Basculer" },

  // ---- Code view ----
  "code.rootUnreadable": {
    en: "Your workspace is still there but macOS is not letting Galactus read it. Open System Settings, Privacy and Security, Files and Folders, and allow Galactus. The folder is remembered and will reopen on its own.",
    fr: "Votre dossier de travail existe toujours mais macOS empêche Galactus de le lire. Ouvrez Réglages Système, Confidentialité et sécurité, Fichiers et dossiers, et autorisez Galactus. Le dossier est mémorisé et se rouvrira tout seul.",
  },
  "code.search.regex": { en: "Regular expression", fr: "Expression régulière" },
  "models.notInstalled": { en: "Not installed yet", fr: "Pas encore installé" },
  "models.expertsWord": { en: "experts", fr: "experts" },
  "models.metaWhy": {
    en: "Family, size on disk, and how many of its experts run per token: a Mixture-of-Experts model uses a few of them at a time, which is why it can be larger than your memory.",
    fr: "Famille, taille sur le disque, et combien de ses experts tournent par jeton : un modèle Mixture-of-Experts n'en utilise que quelques-uns à la fois, et c'est pour cela qu'il peut dépasser votre mémoire.",
  },
  "models.reco": { en: "Start here", fr: "Commencez par celui-ci" },
  "models.recoWhy": {
    en: "The most capable model that still answers at reading speed on this Mac.",
    fr: "Le modèle le plus capable qui répond encore à la vitesse de lecture sur ce Mac.",
  },
  "srvfail.retry": { en: "Try again", fr: "Réessayer" },
  "srvfail.retrying": { en: "Starting...", fr: "Démarrage..." },
  "code.splitHint": {
    en: "Move this file to the other side (Cmd+\\)",
    fr: "Déplacer ce fichier de l'autre côté (Cmd+\\)",
  },
  "fop.newFile": { en: "New file", fr: "Nouveau fichier" },
  "fop.newFolder": { en: "New folder", fr: "Nouveau dossier" },
  "fop.rename": { en: "Rename", fr: "Renommer" },
  "fop.delete": { en: "Move to Trash", fr: "Mettre à la corbeille" },
  "fop.namePrompt": { en: "Name", fr: "Nom" },
  "fop.nameHint": {
    en: "One name, no slashes. It is created next to what you clicked.",
    fr: "Un seul nom, sans barre oblique. Il est créé à côté de ce que vous avez cliqué.",
  },
  "fop.renameHint": { en: "The new name of this entry.", fr: "Le nouveau nom de cet élément." },
  "fop.deleteTitle": { en: "Move to Trash?", fr: "Mettre à la corbeille ?" },
  "fop.deleteBody": {
    en: "%s goes to the Trash. Nothing is erased: drag it back if this was a mistake.",
    fr: "%s part à la corbeille. Rien n'est effacé : glissez-le pour le récupérer si c'était une erreur.",
  },
  "clone.button": { en: "Clone a repository", fr: "Cloner un dépôt" },
  "clone.title": { en: "Clone a repository", fr: "Cloner un dépôt" },
  "clone.urlHint": {
    en: "Paste the address. Galactus clones the latest state only; run `git fetch --unshallow` in the terminal if you need the full history.",
    fr: "Collez l'adresse. Galactus ne clone que l'état actuel ; lancez `git fetch --unshallow` dans le terminal si vous voulez tout l'historique.",
  },
  "clone.working": { en: "Cloning...", fr: "Clonage en cours..." },
  "clone.done": { en: "Cloned into %s", fr: "Cloné dans %s" },
  "code.openTitle": { en: "Open a folder", fr: "Ouvrir un dossier" },
  "code.openBody": {
    en: "Pick the folder you want to work on. Galactus reads its files, follows its git history, and proposes its edits there instead of writing them.",
    fr: "Choisis le dossier sur lequel travailler. Galactus lit ses fichiers, suit son historique git, et y propose ses modifications au lieu de les écrire.",
  },
  "code.openFolder": { en: "Choose a folder", fr: "Choisir un dossier" },
  "code.change": { en: "Change folder", fr: "Changer de dossier" },
  "code.agentPane": { en: "Galactus", fr: "Galactus" },
  "code.pickFile": { en: "Pick a file on the left.", fr: "Choisis un fichier à gauche." },
  "code.cannotOpen": { en: "This file cannot be opened in the editor", fr: "Ce fichier ne peut pas être ouvert dans l'éditeur" },
  "code.save": { en: "Save", fr: "Enregistrer" },
  "code.unsaved": { en: "unsaved", fr: "non enregistré" },
  "code.saveFail": { en: "Save failed: %s", fr: "Échec de l'enregistrement : %s" },
  "code.saveBlocked": {
    en: "Answer the pending hunks first: accept or reject them.",
    fr: "Réponds d'abord aux blocs en attente : accepte-les ou refuse-les.",
  },
  "code.reviewing": { en: "proposed change", fr: "modification proposée" },
  "code.reviewHint": {
    en: "Galactus is waiting for your review. Accept or reject each hunk: only what you accept is written to disk, and the agent cannot finish before your decision.",
    fr: "Galactus attend ta revue. Accepte ou refuse chaque bloc : seul ce que tu acceptes est écrit sur le disque, et l’agent ne peut pas terminer avant ta décision.",
  },
  "code.acceptAll": { en: "Accept all", fr: "Tout accepter" },
  "code.rejectAll": { en: "Reject all", fr: "Tout refuser" },
  "code.pendingTitle": { en: "PROPOSED · %n", fr: "PROPOSÉ · %n" },
  "code.pendingNav": { en: "Files with a change waiting for you", fr: "Fichiers avec une modification en attente" },
  "code.discard": { en: "Discard this proposal", fr: "Abandonner cette proposition" },
  "code.proposalToast": { en: "Change proposed: %s", fr: "Modification proposée : %s" },
  "code.backToEditor": { en: "Back to the file", fr: "Retour au fichier" },

  "code.tab.files": { en: "Files", fr: "Fichiers" },
  // Short on purpose: four tabs share a 274 px column, and a label that
  // overflows its neighbour is worse than a shorter word.
  "code.tab.changes": { en: "Changes", fr: "État" },
  "code.tab.history": { en: "History", fr: "Historique" },
  "code.tab.branches": { en: "Branches", fr: "Branches" },

  "code.noRepo": { en: "not a git repository", fr: "pas un dépôt git" },
  "code.noRepoHint": {
    en: "This folder is not a git repository, so there is no history to show.",
    fr: "Ce dossier n'est pas un dépôt git : il n'y a pas d'historique à afficher.",
  },
  "code.clean": { en: "Working tree clean.", fr: "Rien à valider, l'arbre de travail est propre." },
  "code.staged": { en: "STAGED", fr: "INDEXÉ" },
  "code.unstaged": { en: "NOT STAGED", fr: "NON INDEXÉ" },
  "code.untrackedGroup": { en: "UNTRACKED", fr: "NON SUIVI" },
  "code.stageAll": { en: "stage all", fr: "tout indexer" },
  "code.unstageAll": { en: "unstage all", fr: "tout désindexer" },
  "code.stagedSide": { en: "staged against HEAD", fr: "indexé, comparé à HEAD" },
  "code.unstagedSide": { en: "not staged yet", fr: "pas encore indexé" },
  "code.untracked": { en: "untracked, whole file", fr: "non suivi, fichier entier" },
  "code.noDiff": { en: "(no textual difference)", fr: "(aucune différence textuelle)" },
  "code.commitPlaceholder": { en: "Commit message…", fr: "Message du commit…" },
  "code.commit": { en: "Commit %n file(s)", fr: "Valider %n fichier(s)" },
  "code.commitTitle": { en: "Commit", fr: "Valider" },
  "code.commitSub": {
    en: "%n file(s) go into this commit, on %b. It stays local until you push.",
    fr: "%n fichier(s) entrent dans ce commit, sur %b. Il reste local tant que tu ne pousses pas.",
  },
  "code.commitDo": { en: "Commit", fr: "Valider" },
  "code.commitDone": { en: "Committed: %s", fr: "Commit créé : %s" },
  "code.commitNoMessage": { en: "A commit needs a message.", fr: "Un commit a besoin d'un message." },
  "code.commitNothing": { en: "Nothing is staged.", fr: "Rien n'est indexé." },

  "code.pull": { en: "Pull", fr: "Récupérer" },
  "code.push": { en: "Push", fr: "Pousser" },
  "code.pushDetail": {
    en: "Push %n commit(s) from the local branch %b to %u. Other people will see them.",
    fr: "Pousser %n commit(s) de la branche locale %b vers %u. Les autres les verront.",
  },
  "code.pullDetail": {
    en: "Pull %n commit(s) from %u into %b, fast-forward only. Your files will change.",
    fr: "Récupérer %n commit(s) depuis %u vers %b, en avance rapide seulement. Tes fichiers vont changer.",
  },
  "code.pushDone": { en: "Pushed", fr: "Poussé" },
  "code.pullDone": { en: "Up to date", fr: "À jour" },
  "code.nothingToPush": { en: "Nothing to push: no local commit ahead.", fr: "Rien à pousser : aucun commit local en avance." },
  "code.noUpstream": {
    en: "This branch tracks no remote branch.",
    fr: "Cette branche ne suit aucune branche distante.",
  },
  "code.noCommits": { en: "No commit yet.", fr: "Aucun commit pour l'instant." },
  "code.historyFile": { en: "only %s", fr: "seulement %s" },
  "code.newBranch": { en: "New branch name", fr: "Nom de la nouvelle branche" },
  "code.create": { en: "Create", fr: "Créer" },
  "code.branchPending": {
    en: "Answer the pending proposals before switching branch.",
    fr: "Réponds aux propositions en attente avant de changer de branche.",
  },
  "code.switchPendingTitle": {
    en: "Pending proposals will be discarded",
    fr: "Les propositions en attente seront abandonnées",
  },
  "code.switchPendingSub": {
    en: "%n proposal(s) have not been answered. Opening another folder throws them away: nothing was written to disk and there is no other copy.",
    fr: "%n proposition(s) n'ont pas reçu de réponse. Ouvrir un autre dossier les supprime : rien n'a été écrit sur le disque et il n'en existe aucune autre copie.",
  },
  "code.switchPendingDo": {
    en: "Discard and open",
    fr: "Abandonner et ouvrir",
  },
  "code.reloadKeptDirty": {
    en: "%n file(s) with unsaved edits were left as they are, not reloaded from disk: %s",
    fr: "%n fichier(s) avec des modifications non enregistrées ont été laissés tels quels, sans relecture du disque : %s",
  },

  // ---- editor tabs (code/tabs.ts) ----
  "code.tabClose": { en: "Close", fr: "Fermer" },
  "code.tab.search": { en: "Search", fr: "Recherche" },
  "code.tab.outline": { en: "Outline", fr: "Plan" },
  "code.tab.refs": { en: "References", fr: "Références" },

  // ---- empty and loading states ----
  "code.pickFileTitle": { en: "No file open", fr: "Aucun fichier ouvert" },
  "code.emptyFolder": { en: "This folder is empty.", fr: "Ce dossier est vide." },
  "code.loading": { en: "Loading…", fr: "Chargement…" },

  // ---- git absent, as a stated fact and never an installer dialog ----
  "code.gitUnavailable": { en: "git is not installed on this Mac", fr: "git n'est pas installé sur ce Mac" },
  "code.gitUnavailableBody": {
    en: "Changes, History and Branches need git. Galactus never triggers Apple's Command Line Tools installer: install git yourself to turn version control on here.",
    fr: "État, Historique et Branches ont besoin de git. Galactus ne déclenche jamais l'installateur des Command Line Tools d'Apple : installe git toi-même pour activer le contrôle de version ici.",
  },

  // ---- project search panel (code/searchpanel.ts) ----
  "code.search.placeholder": { en: "Search in the project", fr: "Chercher dans le projet" },
  "code.search.case": { en: "Match case", fr: "Respecter la casse" },
  "code.search.word": { en: "Whole word", fr: "Mot entier" },
  "code.search.globs": { en: "Files to include or exclude", fr: "Fichiers à inclure ou exclure" },
  "code.search.include": { en: "include, e.g. *.ts, src/**", fr: "inclure, ex. *.ts, src/**" },
  "code.search.exclude": { en: "exclude, e.g. vendor/**", fr: "exclure, ex. vendor/**" },
  "code.search.replaceToggle": { en: "Replace", fr: "Remplacer" },
  "code.search.replacePlaceholder": { en: "Replace with", fr: "Remplacer par" },
  "code.search.replaceDo": { en: "Propose in %f files", fr: "Proposer dans %f fichiers" },
  "code.search.hint": {
    en: "Type to search the whole project. Literal text, no regular expressions.",
    fr: "Tape pour chercher dans tout le projet. Texte littéral, pas d'expressions régulières.",
  },
  "code.search.running": { en: "Searching… %n found", fr: "Recherche… %n trouvés" },
  "code.search.results": { en: "%n results in %f files", fr: "%n résultats dans %f fichiers" },
  "code.search.none": { en: "No match in the project.", fr: "Aucune correspondance dans le projet." },
  "code.search.cancel": { en: "Stop", fr: "Arrêter" },
  "code.search.capped": {
    en: "Too many matches: the search stopped early and this list is incomplete.",
    fr: "Trop de correspondances : la recherche s'est arrêtée, cette liste est incomplète.",
  },
  "code.search.timedOut": {
    en: "The search ran out of time and this list is incomplete.",
    fr: "La recherche a dépassé son temps imparti, cette liste est incomplète.",
  },
  "code.search.clientCapped": {
    en: "Only the first %n matches are kept. Narrow the search.",
    fr: "Seules les %n premières correspondances sont conservées. Affine la recherche.",
  },
  "code.search.rowsShown": { en: "showing %n of %m", fr: "%n affichés sur %m" },
  "code.symbols.heuristic": {
    en: "Heuristic index: a symbol produced by a macro can be missing.",
    fr: "Index heuristique : un symbole produit par une macro peut manquer.",
  },

  // ---- palettes (code/palette.ts) ----
  "code.pal.filesPlaceholder": { en: "Go to file", fr: "Aller au fichier" },
  "code.pal.symbolsPlaceholder": { en: "Go to symbol", fr: "Aller au symbole" },
  "code.pal.footer": {
    en: "↑↓ to move · ⏎ to open · esc to close",
    fr: "↑↓ pour naviguer · ⏎ pour ouvrir · échap pour fermer",
  },
  "code.pal.loading": { en: "Indexing the workspace…", fr: "Indexation de l'espace de travail…" },
  "code.pal.none": { en: "Nothing matches.", fr: "Aucune correspondance." },

  // ---- project-wide replace, as proposals (code/replace.ts) ----
  "code.replace.title": { en: "Propose this replacement", fr: "Proposer ce remplacement" },
  "code.replace.sub": {
    en: "%n matches in %f files. Each file becomes a pending diff you review hunk by hunk. Nothing is written yet.",
    fr: "%n correspondances dans %f fichiers. Chaque fichier devient une modification en attente, revue bloc par bloc. Rien n'est encore écrit.",
  },
  "code.replace.do": { en: "Propose", fr: "Proposer" },
  "code.replace.tooMany": {
    en: "%f files is too many to review at once (limit %c). Narrow the search first.",
    fr: "%f fichiers, c'est trop à revoir d'un coup (limite %c). Affine d'abord la recherche.",
  },
  "code.replace.none": { en: "Nothing changed: those matches are stale.", fr: "Rien n'a changé : ces correspondances sont périmées." },
  "code.replace.partial": {
    en: "%n of %m files changed. The rest moved under the search.",
    fr: "%n fichiers sur %m ont changé. Les autres ont bougé sous la recherche.",
  },

  // ---- outline (code/outline.ts, code/pylang.ts) ----
  "outline.empty": { en: "Nothing to outline in this file.", fr: "Rien à lister dans ce fichier." },
  "outline.partial": { en: "Parsing, the outline is still filling in.", fr: "Analyse en cours, le plan se complète." },
  "outline.pythonExact": { en: "Exact, from the bundled Python 3.12.", fr: "Exact, via le Python 3.12 embarqué." },
  "outline.noGrammar": {
    en: "No bundled grammar for this file type, so there is nothing to outline.",
    fr: "Aucune grammaire embarquée pour ce type de fichier : il n'y a rien à lister.",
  },

  // ---- diagnostics scope, said plainly (code/treediag.ts) ----
  "diag.syntaxOnly": {
    en: "Syntax only. Not types, not undefined variables, not unused imports: a file with no error here is a file the grammar could parse, nothing more.",
    fr: "Syntaxe uniquement. Ni types, ni variables inconnues, ni imports inutilisés : un fichier sans erreur ici est un fichier que la grammaire a su lire, rien de plus.",
  },
  "diag.pythonNoTypes": {
    en: "Python: exact syntax errors, no type inference. No hover types and no member completion.",
    fr: "Python : erreurs de syntaxe exactes, pas d'inférence de types. Pas de type au survol ni de complétion de membres.",
  },
  "diag.syntax.rust": {
    en: "Rust syntax: the parser cannot continue here%s.",
    fr: "Syntaxe Rust : l'analyseur ne peut pas continuer ici%s.",
  },
  "diag.syntax.python": {
    en: "Python syntax: the parser cannot continue here%s.",
    fr: "Syntaxe Python : l'analyseur ne peut pas continuer ici%s.",
  },
  "diag.syntax.javascript": {
    en: "JavaScript syntax: the parser cannot continue here%s.",
    fr: "Syntaxe JavaScript : l'analyseur ne peut pas continuer ici%s.",
  },
  "diag.syntax.typescript": {
    en: "TypeScript syntax: the parser cannot continue here%s.",
    fr: "Syntaxe TypeScript : l'analyseur ne peut pas continuer ici%s.",
  },
  "diag.syntax.json": {
    en: "JSON syntax: the parser cannot continue here%s.",
    fr: "Syntaxe JSON : l'analyseur ne peut pas continuer ici%s.",
  },
  "diag.syntax.markdown": {
    en: "Markdown syntax: the parser cannot continue here%s.",
    fr: "Syntaxe Markdown : l'analyseur ne peut pas continuer ici%s.",
  },
  "diag.syntax.html": {
    en: "HTML syntax: unclosed or misplaced markup here%s.",
    fr: "Syntaxe HTML : balise non fermée ou mal placée ici%s.",
  },
  "diag.syntax.css": {
    en: "CSS syntax: the parser cannot continue here%s.",
    fr: "Syntaxe CSS : l'analyseur ne peut pas continuer ici%s.",
  },

  // ---- the tier badge (code/tiers.ts) ----
  "tier.a.label": { en: "Full", fr: "Complet" },
  "tier.b.label": { en: "Syntax", fr: "Syntaxe" },
  "tier.none.label": { en: "Plain", fr: "Brut" },
  "tier.a.hint": {
    en: "Types, hover, go to definition, references and rename, from a language service running inside the app: TypeScript from its own snapshot, Rust from the bundled rust-analyzer. The TypeScript snapshot is taken at the last open, pull or checkout, so a file changed outside Galactus is stale to it until one of those happens.",
    fr: "Types, survol, aller à la définition, références et renommage, via un service de langage exécuté dans l'app : TypeScript depuis son propre instantané, Rust via le rust-analyzer embarqué. L'instantané TypeScript est pris à la dernière ouverture, au dernier pull ou au dernier changement de branche : un fichier modifié hors de Galactus lui reste invisible jusque-là.",
  },
  "tier.b.hint": {
    en: "Outline, breadcrumb and syntax errors, from the bundled grammar. No types, no cross-file resolution, no go to definition. C gets this tier only, and so does Rust while the language server is starting or absent.",
    fr: "Plan, fil d'Ariane et erreurs de syntaxe, via la grammaire embarquée. Pas de types, pas de résolution inter-fichiers, pas d'aller à la définition. C n'a que ce niveau, et Rust aussi tant que le serveur de langage démarre ou est absent.",
  },
  "tier.none.hint": {
    en: "No bundled grammar for this file type: line numbers, search and undo only. Nothing is analysed.",
    fr: "Aucune grammaire embarquée pour ce type de fichier : numéros de ligne, recherche et annulation seulement. Rien n'est analysé.",
  },

  // ---- the TypeScript service (src/tsintel) ----
  "tsintel.tierB": { en: "Basic highlighting only: %s", fr: "Coloration simple uniquement : %s" },
  "tsintel.references": { en: "References", fr: "Références" },
  "tsintel.noRefs": { en: "no references", fr: "aucune référence" },
  "tsintel.refCount": { en: "%n references in %f files", fr: "%n références dans %f fichiers" },
  "tsintel.needsImport": { en: "needs an import", fr: "nécessite un import" },
  "tsintel.stale": {
    en: "Types reflect the last pull or checkout, not changes made outside Galactus.",
    fr: "Les types reflètent le dernier pull ou changement de branche, pas les modifications faites hors de Galactus.",
  },
  "tsintel.renameTitle": { en: "Rename this symbol", fr: "Renommer ce symbole" },
  "tsintel.renameBody": {
    en: "Every file the rename touches becomes a pending diff you review hunk by hunk. Nothing is written yet.",
    fr: "Chaque fichier touché par le renommage devient une modification en attente, revue bloc par bloc. Rien n'est encore écrit.",
  },
  "tsintel.renamePrompt": { en: "New name", fr: "Nouveau nom" },
  "tsintel.renameProposed": { en: "Rename proposed in %n files", fr: "Renommage proposé dans %n fichiers" },
  "tsintel.renameFail": { en: "Rename refused: %s", fr: "Renommage refusé : %s" },
  "tsintel.needsTierA": {
    en: "Rename needs the TypeScript service, which is not running for this file.",
    fr: "Le renommage a besoin du service TypeScript, qui ne tourne pas pour ce fichier.",
  },

  // ---- the Rust language server (code/rust-lsp.ts, src-tauri/src/lsp.rs) ----
  "rustlsp.starting": {
    en: "Starting the Rust language server",
    fr: "Démarrage du serveur de langage Rust",
  },
  "rustlsp.indexing": {
    en: "Indexing the crate graph: answers are incomplete until this finishes",
    fr: "Indexation du graphe de crates : les réponses sont incomplètes jusqu'à la fin",
  },
  "rustlsp.failed": { en: "Rust intelligence is off: %s", fr: "Intelligence Rust désactivée : %s" },
  "rustlsp.partial": { en: "Rust intelligence is limited: %s", fr: "Intelligence Rust limitée : %s" },
  "rustlsp.needsReady": {
    en: "Rename needs the Rust language server to have finished indexing",
    fr: "Le renommage attend la fin de l'indexation du serveur de langage Rust",
  },

  // ---- workspace tools the model may call ----
  "tool.searchWorkspace": { en: "Search the workspace", fr: "Chercher dans l'espace de travail" },
  "tool.findFiles": { en: "Find files", fr: "Trouver des fichiers" },

  // ---- updates ----
  "sect.updates": { en: "Updates", fr: "Mises à jour" },
  "sect.updatesHint": {
    en: "Install the next version of Galactus without downloading it by hand",
    fr: "Installer la prochaine version de Galactus sans la télécharger à la main",
  },
  "update.current": { en: "This version", fr: "Cette version" },
  "update.check": { en: "Check now", fr: "Vérifier" },
  "update.checking": { en: "Checking...", fr: "Vérification..." },
  "update.upToDate": {
    en: "Galactus %s is the latest version.",
    fr: "Galactus %s est la derniere version.",
  },
  "update.found": { en: "Version %s is available.", fr: "La version %s est disponible." },
  "update.version": { en: "Version %s", fr: "Version %s" },
  "update.failed": { en: "Update failed: %s", fr: "Échec de la mise à jour : %s" },
  "update.install": { en: "Download and install", fr: "Télécharger et installer" },
  "update.downloading": { en: "Downloading...", fr: "Telechargement..." },
  "update.later": { en: "Not now", fr: "Pas maintenant" },
  "update.declined": {
    en: "Staying on version %s. The offer comes back at the next launch.",
    fr: "On reste en version %s. L'offre revient au prochain lancement.",
  },
  "update.restart": { en: "Restart now", fr: "Redémarrer" },
  "update.readyHint": {
    en: "Installed. Galactus uses it after a restart.",
    fr: "Installee. Galactus l'utilisera après un redemarrage.",
  },
  "update.installedHint": {
    en: "The new version is on disk. Restart when you are ready.",
    fr: "La nouvelle version est sur le disque. Redemarre quand tu veux.",
  },
  "update.busyJobs": {
    en: "A run is still working. Updating now would end it with no way back. Wait for it to finish, or stop it in Runs.",
    fr: "Un run est encore en cours. Mettre a jour maintenant l'interromprait sans retour possible. Attends la fin, ou arrete-le dans Runs.",
  },
  "update.serverWarn": {
    en: "This machine serves a model and may run scheduled jobs. Restarting stops both until Galactus is back.",
    fr: "Cette machine sert un modèle et peut exécuter des taches planifiees. Redémarrer arrete les deux jusqu'au retour de Galactus.",
  },
  "update.autoTitle": { en: "Check at launch", fr: "Vérifier au lancement" },
  "update.autoHint": {
    en: "Look once, a few seconds after start. It never downloads and never restarts on its own.",
    fr: "Regarder une fois, quelques secondes après le demarrage. Aucun telechargement ni redemarrage automatique.",
  },
  "update.autoServer": {
    en: "Off in server mode: a machine running unattended is never interrupted by an offer nobody is there to decline.",
    fr: "Desactive en mode serveur : une machine sans personne devant n'est jamais interrompue par une offre que personne ne peut refuser.",
  },

  // ---- page section headings ----
  "sect.appearance": { en: "Appearance", fr: "Apparence" },
  "sect.appearanceHint": { en: "Language and where Galactus keeps its data", fr: "Langue et emplacement des données de Galactus" },
  "sect.engine": { en: "Engine", fr: "Moteur" },
  "sect.engineHint": { en: "How the model is loaded and how much of the Mac it takes", fr: "Comment le modèle est chargé et ce qu'il prend de la machine" },
  "settings.appliedNextStart": {
    en: "Applied the next time a model starts",
    fr: "Appliqué au prochain démarrage d'un modèle",
  },
  "settings.ctx": { en: "Context window", fr: "Fenêtre de contexte" },
  "settings.ctxHint": {
    en: "How much a conversation can hold before it forgets its start. Larger windows cost memory: the engine keeps one cache per slot, and it grows with the window. Bounded by what the model was trained on.",
    fr: "Ce qu'une conversation peut retenir avant d'oublier son début. Une fenêtre plus large coûte de la mémoire : le moteur garde un cache par créneau, et il grandit avec la fenêtre. Borné par ce sur quoi le modèle a été entraîné.",
  },
  "settings.thinking": { en: "Reasoning", fr: "Raisonnement" },
  "settings.thinkingHint": {
    en: "Let a reasoning model think before it answers. It is why those models are good, and it costs a minute of invisible tokens before the first word. Turn it off for long mechanical output like a file of code.",
    fr: "Laisser un modèle à raisonnement réfléchir avant de répondre. C'est ce qui fait leur qualité, et cela coûte une minute de tokens invisibles avant le premier mot. À couper pour une longue production mécanique comme un fichier de code.",
  },
  "settings.sampling": { en: "Sampling", fr: "Échantillonnage" },
  "settings.samplingHint": {
    en: "How the model picks each token. Every model publishes the values it was tuned with; these apply to all conversations until you change them.",
    fr: "Comment le modèle choisit chaque token. Chaque modèle publie les valeurs sur lesquelles il a été réglé ; celles-ci s'appliquent à toutes les discussions jusqu'à modification.",
  },
  "settings.temp": { en: "Temperature", fr: "Température" },
  "settings.topP": { en: "top_p", fr: "top_p" },
  "settings.topK": { en: "top_k", fr: "top_k" },
  "settings.samplingReset": { en: "Reset", fr: "Réinitialiser" },
  "sect.access": { en: "Access", fr: "Accès" },
  "sect.accessHint": { en: "What other programs and the agent are allowed to reach", fr: "Ce que les autres programmes et l'agent ont le droit d'atteindre" },
  "sect.ide": { en: "Code intelligence", fr: "Intelligence de code" },
  "sect.ideHint": { en: "Local completions, diagnostics and isolated extensions", fr: "Complétions locales, diagnostics et extensions isolées" },
  "settings.autoTab": { en: "Auto Tab", fr: "Auto Tab" },
  "settings.autoTabHint": { en: "Local ghost-text completion · Tab accepts · Escape dismisses", fr: "Complétion locale en texte fantôme · Tab accepte · Échap masque" },
  "settings.syntax": { en: "Syntax and language services", fr: "Syntaxe et services de langage" },
  "settings.syntaxHint": { en: "Built-in diagnostics for Python, TypeScript, JavaScript, JSON, Rust, CSS, HTML and Markdown", fr: "Diagnostics intégrés pour Python, TypeScript, JavaScript, JSON, Rust, CSS, HTML et Markdown" },
  "settings.extensions": { en: "Extensions", fr: "Extensions" },
  "settings.extensionsHint": { en: "Capabilities run through sandboxed MCP connectors and packaged skills; arbitrary editor scripts are never injected", fr: "Les capacités passent par des connecteurs MCP isolés et des skills intégrés ; aucun script d'éditeur arbitraire n'est injecté" },
  "settings.openConnectors": { en: "Connectors", fr: "Connecteurs" },
  "settings.openSkills": { en: "Skills", fr: "Skills" },
  "code.autoTabReady": { en: "Auto Tab ready", fr: "Auto Tab prêt" },

  // ---- inline edit at the cursor, Cmd+K (code/inline-edit.ts) ----
  "code.inlineEdit.lines": { en: "lines %a to %b", fr: "lignes %a à %b" },
  "code.inlineEdit.placeholder": { en: "Describe the change...", fr: "Décris la modification..." },
  "code.inlineEdit.submit": { en: "Edit", fr: "Modifier" },
  "code.inlineEdit.hint": {
    en: "Enter to send, Esc to cancel. The result arrives as a diff.",
    fr: "Entrée pour envoyer, Échap pour annuler. Le résultat arrive en diff.",
  },
  "code.inlineEdit.working": { en: "Thinking...", fr: "Réflexion..." },
  "code.inlineEdit.tooBig": {
    en: "Selection too large for one inline edit",
    fr: "Sélection trop grande pour une modification en ligne",
  },
  "code.inlineEdit.badAnswer": {
    en: "The model did not return usable code",
    fr: "Le modèle n'a pas renvoyé de code exploitable",
  },
  "code.inlineEdit.noChange": {
    en: "The model returned the same code",
    fr: "Le modèle a renvoyé le même code",
  },
  "code.inlineEdit.stale": {
    en: "The file changed while the model was thinking",
    fr: "Le fichier a changé pendant la réflexion du modèle",
  },
  "code.inlineEdit.failed": {
    en: "Inline edit failed",
    fr: "Échec de la modification en ligne",
  },
  "sect.memory": { en: "Memory", fr: "Mémoire" },
  "sect.memoryHint": { en: "What Galactus remembers about you between conversations", fr: "Ce que Galactus retient de toi d'une conversation à l'autre" },
  "sect.knowledge": { en: "Knowledge", fr: "Connaissances" },
  "sect.knowledgeHint": { en: "Local folders indexed for full-text search, offline", fr: "Dossiers locaux indexés pour la recherche plein texte, hors ligne" },
  "sect.obsidian": { en: "Obsidian", fr: "Obsidian" },
  "sect.obsidianHint": { en: "An existing vault, read and written in place", fr: "Un coffre existant, lu et écrit sur place" },

  "perm.code": { en: "Propose a change to a file", fr: "Proposer une modification de fichier" },
  "perm.codeNote": {
    en: "Nothing is written now: the change opens in the editor and you accept or reject it hunk by hunk.",
    fr: "Rien n'est écrit maintenant : la modification s'ouvre dans l'éditeur et tu l'acceptes ou la refuses bloc par bloc.",
  },
  "perm.git": { en: "Reach the git remote", fr: "Contacter le dépôt distant" },

  "preview.title": { en: "Preview", fr: "Aperçu" },
  "preview.refresh": { en: "Refresh", fr: "Rafraîchir" },
  "preview.openBrowser": { en: "Open in browser", fr: "Ouvrir dans le navigateur" },
  "preview.close": { en: "Close", fr: "Fermer" },
  "preview.copied": { en: "copied", fr: "copié" },
  "preview.mermaidMissing": {
    // Says what IS, not what is missing. This app ships no Mermaid renderer and
    // will not fetch one, since nothing in a preview is allowed to reach the
    // network. The old wording read as a temporary fault the reader might fix;
    // it was the only behaviour there has ever been.
    en: "Diagrams are shown as source: Galactus renders nothing it would have to download.",
    fr: "Les diagrammes sont affichés en source : Galactus n'affiche rien qu'il faudrait télécharger.",
  },
  "preview.mermaidError": {
    en: "The diagram could not be rendered. Showing the source.",
    fr: "Le diagramme n'a pas pu être rendu. Voici la source.",
  },
  "preview.svgError": {
    en: "Invalid SVG. Showing the source.",
    fr: "SVG invalide. Voici la source.",
  },
  "preview.empty": { en: "Nothing to preview.", fr: "Rien à prévisualiser." },

  // ---- the integrated terminal (code/terminal.ts, src-tauri/src/pty.rs) ----
  "term.title": { en: "Terminal", fr: "Terminal" },
  "term.new": { en: "New terminal", fr: "Nouveau terminal" },
  "term.close": { en: "Close this terminal", fr: "Fermer ce terminal" },
  "term.clear": { en: "Clear the screen and the history", fr: "Effacer l'écran et l'historique" },
  "prev.toggle": { en: "Preview", fr: "Aperçu" },
  "prev.nothing": {
    en: "No page to preview yet. Open an .html file, or ask the agent to create index.html.",
    fr: "Aucune page à prévisualiser. Ouvrez un fichier .html, ou demandez à l'agent de créer index.html.",
  },
  "prev.pending": {
    en: "%n change(s) waiting for you. The preview shows the files on disk, so they are not in it yet.",
    fr: "%n modification(s) en attente. L'aperçu montre les fichiers sur le disque : elles n'y sont donc pas encore.",
  },
  "prev.sealed": {
    en: "Nothing loads from the internet here. A page that uses a CDN renders without it.",
    fr: "Rien ne se charge depuis internet ici. Une page qui utilise un CDN s'affiche sans lui.",
  },
  "prev.reload": { en: "Reload", fr: "Recharger" },
  "ssh.unavailable": {
    en: "Remote sessions are not available in this build.",
    fr: "Les sessions distantes ne sont pas disponibles dans cette version.",
  },
  "ssh.title": { en: "Remote machines", fr: "Machines distantes" },
  "ssh.add": { en: "Add a machine", fr: "Ajouter une machine" },
  "ssh.addHint": {
    en: "Write user@host, or a name from your ~/.ssh/config. Galactus never stores a password: it connects with the keys your ssh already uses.",
    fr: "Écrivez utilisateur@hôte, ou un nom de votre ~/.ssh/config. Galactus ne conserve aucun mot de passe : la connexion utilise les clés que votre ssh emploie déjà.",
  },
  "ssh.connect": { en: "Connect", fr: "Se connecter" },
  "ssh.remove": { en: "Forget", fr: "Oublier" },
  "ssh.none": { en: "No machine saved yet.", fr: "Aucune machine enregistrée." },
  "term.toggle": { en: "Terminal", fr: "Terminal" },
  "term.empty": {
    en: "No terminal open. Press + to start one in the workspace folder.",
    fr: "Aucun terminal ouvert. Appuie sur + pour en lancer un dans le dossier du projet.",
  },
  "term.noWorkspace": {
    en: "Open a folder before starting a terminal.",
    fr: "Ouvre un dossier avant de lancer un terminal.",
  },
  "term.exited": { en: "exited (%s)", fr: "terminé (%s)" },
  "term.killed": { en: "killed", fr: "arrêté" },

  // ---- unattended runs (runsview.ts, runs.ts, rundrive.ts) ----
  "runs.subtitle": {
    en: "A task, a budget, a policy. Then nobody has to watch.",
    fr: "Une tâche, un budget, une politique. Ensuite, personne n'a à regarder.",
  },
  "runs.sectNew": { en: "New run", fr: "Nouveau run" },
  "runs.sectNewHint": {
    en: "Everything a run may do is decided here, before its first token",
    fr: "Tout ce qu'un run pourra faire se décide ici, avant son premier token",
  },
  "runs.sectList": { en: "Runs", fr: "Runs" },
  "runs.sectListHint": {
    en: "They keep going when this screen is closed, and come back when the app reopens",
    fr: "Ils continuent quand cet écran est fermé, et reviennent à la réouverture de l'app",
  },
  "runs.name": { en: "Name", fr: "Nom" },
  "runs.namePlaceholder": { en: "Optional: taken from the task otherwise", fr: "Facultatif : repris de la tâche sinon" },
  "runs.task": { en: "Task", fr: "Tâche" },
  "runs.taskPlaceholder": {
    en: "What this run has to produce. Be precise: nobody will be there to clarify it.",
    fr: "Ce que ce run doit produire. Sois précis : personne ne sera là pour préciser.",
  },
  "runs.policy": { en: "Policy", fr: "Politique" },
  "runs.policy.read_only": { en: "Read only", fr: "Lecture seule" },
  "runs.policy.propose": { en: "Propose", fr: "Proposer" },
  "runs.policy.autonomous": { en: "Autonomous", fr: "Autonome" },
  "runs.policyHint.read_only": {
    en: "Look, never touch. Nothing changes and nothing leaves the machine.",
    fr: "Regarder, jamais toucher. Rien ne change et rien ne quitte la machine.",
  },
  "runs.policyHint.propose": {
    en: "Read only, plus the web and code proposals. A proposal waits for you in the editor.",
    fr: "Lecture seule, plus le web et les propositions de code. Une proposition t'attend dans l'éditeur.",
  },
  "runs.policyHint.autonomous": {
    en: "Every ordinary permission. Elevated ones stay refused, whatever the policy says.",
    fr: "Toutes les permissions ordinaires. Les permissions élevées restent refusées, quoi qu'en dise la politique.",
  },
  "runs.preauth": {
    en: "Answer the every-time requests now",
    fr: "Répondre maintenant aux demandes systématiques",
  },
  "runs.preauthHint": {
    en: "git push and git pull are the only two things that still stop an autonomous run, because the attended gate shows them every time. Nobody is watching this one, so decide here or it will stop.",
    fr: "git push et git pull sont les deux seules choses qui arretent encore une run autonome, parce que la validation surveillee les montre a chaque fois. Personne ne regarde celle-ci : décide ici, sinon elle s'arretera.",
  },
  "runs.turns": { en: "Turns", fr: "Tours" },
  "runs.turnsUnit": { en: "turns", fr: "tours" },
  "runs.minutes": { en: "Minutes", fr: "Minutes" },
  "runs.budgetHint": {
    en: "The clock counts working time only: waiting for you is free.",
    fr: "L'horloge ne compte que le temps de travail : t'attendre ne coûte rien.",
  },
  "runs.start": { en: "Start", fr: "Démarrer" },
  "runs.stop": { en: "Stop", fr: "Arrêter" },
  "runs.delete": { en: "Delete", fr: "Supprimer" },
  "runs.showLog": { en: "Transcript", fr: "Transcription" },
  "runs.hideLog": { en: "Hide", fr: "Masquer" },
  "runs.logTrimmed": { en: "%n earlier entries are on disk", fr: "%n entrées antérieures sont sur le disque" },
  "runs.result": { en: "Result", fr: "Résultat" },
  "runs.failure": { en: "Failure", fr: "Échec" },
  "runs.empty": { en: "No run yet", fr: "Aucun run pour l'instant" },
  "runs.loading": { en: "Reading the stored runs", fr: "Lecture des runs enregistrés" },
  "runs.emptyHint": {
    en: "Declare one above. It runs on the model that is loaded, under the policy you pick.",
    fr: "Déclares-en un ci-dessus. Il tourne sur le modèle chargé, sous la politique choisie.",
  },
  "runs.needModel": { en: "Start a model first.", fr: "Démarre d'abord un modèle." },
  "runs.needTask": { en: "Write the task first.", fr: "Écris d'abord la tâche." },
  "runs.notBlocked": { en: "This run is no longer waiting for an answer.", fr: "Ce run n'attend plus de réponse." },
  "runs.untraceable": {
    en: "The step this run stopped on is not in its transcript, so it cannot be granted.",
    fr: "L'étape sur laquelle ce run s'est arrêté n'est pas dans sa transcription : impossible de l'accorder.",
  },
  "runs.blockedTitle": { en: "Waiting for a human", fr: "En attente d'un humain" },
  "runs.blockedHint": {
    en: "The clock is stopped. Granting covers this run only, and dies with it.",
    fr: "L'horloge est arrêtée. Accorder ne vaut que pour ce run, et disparaît avec lui.",
  },
  "runs.notePlaceholder": { en: "A word for the run (optional)", fr: "Un mot pour le run (facultatif)" },
  "runs.grant": { en: "Grant", fr: "Accorder" },
  "runs.refuse": { en: "Refuse", fr: "Refuser" },
  "runs.grantsCount": { en: "%n granted", fr: "%n accordées" },
  "runs.grantsHint": {
    en: "Permissions a human granted this run, recorded in its transcript",
    fr: "Permissions accordées à ce run par un humain, inscrites dans sa transcription",
  },
  "runs.notifyBlocked": { en: "waiting for an answer", fr: "en attente d'une réponse" },
  "runs.engineGone": {
    en: "the engine it was running on was stopped",
    fr: "le moteur sur lequel il tournait a été arrêté",
  },
  "runs.state.queued": { en: "queued", fr: "en attente" },
  "runs.state.running": { en: "running", fr: "en cours" },
  "runs.state.blocked": { en: "blocked", fr: "bloqué" },
  "runs.state.finished": { en: "finished", fr: "terminé" },
  "runs.state.failed": { en: "failed", fr: "échoué" },
  "runs.state.cancelled": { en: "cancelled", fr: "annulé" },
  "runs.state.exhausted": { en: "exhausted", fr: "épuisé" },

  // ---- scheduled jobs (schedule.ts, scheduler.rs, cron.rs) ----
  "sched.sect": { en: "Scheduled", fr: "Planifié" },
  "sched.sectHint": {
    en: "A run template plus a schedule. The clock lives outside this window and survives it.",
    fr: "Un modèle de run plus un horaire. L'horloge vit hors de cette fenêtre et lui survit.",
  },
  "sched.limit": {
    en: "Closing the window keeps jobs running: it hides the window instead of destroying it, and a menu bar item says so. Quitting Galactus really does stop them.",
    fr: "Fermer la fenêtre n'arrête pas les jobs : elle est masquée et non détruite, et un élément de la barre de menus le signale. Quitter Galactus les arrête pour de bon.",
  },
  "sched.new": { en: "New job", fr: "Nouveau job" },
  "sched.edit": { en: "Edit", fr: "Modifier" },
  "sched.cancelEdit": { en: "Cancel", fr: "Annuler" },
  "sched.save": { en: "Save job", fr: "Enregistrer" },
  "sched.delete": { en: "Delete", fr: "Supprimer" },
  "sched.runNow": { en: "Run now", fr: "Lancer" },
  "sched.enable": { en: "Enable", fr: "Activer" },
  "sched.disable": { en: "Disable", fr: "Désactiver" },
  "sched.on": { en: "on", fr: "actif" },
  "sched.off": { en: "off", fr: "inactif" },
  "sched.running": { en: "running", fr: "en cours" },
  "sched.when": { en: "Schedule", fr: "Horaire" },
  "sched.whenHint": {
    en: "Five fields (minute hour day month weekday), or 30m, every 2h, @daily.",
    fr: "Cinq champs (minute heure jour mois jour-semaine), ou 30m, every 2h, @daily.",
  },
  "sched.whenPlaceholder": { en: "0 9 * * 1-5", fr: "0 9 * * 1-5" },
  "sched.next": { en: "Next", fr: "Prochain" },
  "sched.nextNone": { en: "no next fire", fr: "aucun déclenchement prévu" },
  "sched.preview": { en: "Next fires", fr: "Prochains déclenchements" },
  "sched.last": { en: "Last", fr: "Dernier" },
  "sched.never": { en: "never run", fr: "jamais lancé" },
  "sched.missed": { en: "%n missed", fr: "%n manqués" },
  "sched.failures": { en: "%n failures in a row", fr: "%n échecs d'affilée" },
  "sched.delivery": { en: "Output", fr: "Sortie" },
  "sched.delivery.none": { en: "Nowhere", fr: "Nulle part" },
  "sched.delivery.webhook": { en: "Webhook", fr: "Webhook" },
  "sched.delivery.file": { en: "File", fr: "Fichier" },
  "sched.deliveryHint": {
    en: "Nowhere by default. Nothing leaves this Mac unless you name a target here.",
    fr: "Nulle part par défaut. Rien ne quitte ce Mac tant que tu ne nommes pas une cible ici.",
  },
  "sched.webhookPlaceholder": { en: "https://example.com/hook", fr: "https://example.com/hook" },
  "sched.filePlaceholder": { en: "/Users/you/galactus-jobs.log", fr: "/Users/toi/galactus-jobs.log" },
  "sched.delivered": { en: "delivered", fr: "livré" },
  "sched.deliveryFailed": { en: "delivery failed: %n", fr: "livraison échouée : %n" },
  "sched.empty": { en: "No scheduled job", fr: "Aucun job planifié" },
  "sched.emptyHint": {
    en: "A job declares the same run you would declare by hand, and the clock declares it for you.",
    fr: "Un job déclare le même run que tu déclarerais à la main, et l'horloge le déclare à ta place.",
  },
  "sched.needTask": { en: "Write the task first.", fr: "Écris d'abord la tâche." },
  "sched.needSchedule": { en: "Write a schedule first.", fr: "Écris d'abord un horaire." },
  "sched.needWebhook": { en: "Write the webhook URL.", fr: "Indique l'URL du webhook." },
  "sched.needFile": { en: "Write the file path.", fr: "Indique le chemin du fichier." },
  "sched.catchup": {
    en: "A job whose time passed while Galactus was closed runs ONCE, late, if it is less than %n minutes overdue. Older ones are recorded as missed and not run.",
    fr: "Un job dont l'heure est passée pendant que Galactus était fermé s'exécute UNE fois, en retard, s'il a moins de %n minutes de retard. Les plus anciens sont notés comme manqués et ne sont pas lancés.",
  },
  "sched.fileError": {
    en: "The scheduler refused a file on disk and nothing will fire until it is fixed:",
    fr: "Le planificateur a refusé un fichier sur le disque, et rien ne se déclenchera avant correction :",
  },
  "sched.lateNotice": { en: "started late, %n other fires were skipped", fr: "démarré en retard, %n autres déclenchements ignorés" },
  "sched.lateNoticeOne": { en: "started late", fr: "démarré en retard" },

  // ---- procedural memory (learned.ts, learnedbank.ts, learnedview.ts) ----
  "learned.title": { en: "What Galactus taught itself", fr: "Ce que Galactus s'est appris" },
  "learned.subtitle": {
    en: "Procedures the agent wrote for itself after a task. None of these shipped with the app.",
    fr: "Des procédures que l'agent s'est écrites après une tâche. Aucune n'est livrée avec l'app.",
  },
  "learned.switchTitle": { en: "Learn from finished tasks", fr: "Apprendre des tâches terminées" },
  "learned.switchDesc": {
    en: "Off by default. When on, a task that recurs may become a skill.",
    fr: "Désactivé par défaut. Une fois actif, une tâche qui revient peut devenir une skill.",
  },
  "learned.switchHint": {
    en: "The bar is high on purpose: five tool calls or more, no denied step, at least two actions that change something, and the same shape seen at least twice. What the agent writes lands in this list, never among the skills that ship with the app, and it waits here until you accept it.",
    fr: "La barre est haute volontairement : au moins cinq appels d'outils, aucune étape refusée, au moins deux actions qui changent quelque chose, et la même forme vue au moins deux fois. Ce que l'agent écrit arrive dans cette liste, jamais parmi les skills livrées avec l'app, et y attend que tu l'acceptes.",
  },
  "learned.empty": { en: "Nothing learned yet", fr: "Rien d'appris pour l'instant" },
  "learned.emptyHint": {
    en: "Most tasks never get here, which is the point. A procedure is written on the second time a shape of work comes back, not the first.",
    fr: "La plupart des tâches n'arrivent jamais ici, et c'est le but. Une procédure s'écrit la deuxième fois qu'une forme de travail revient, pas la première.",
  },
  "learned.noDescription": { en: "no description", fr: "sans description" },
  "learned.tagSelf": { en: "self-authored", fr: "écrite par l'agent" },
  "learned.tagAttended": { en: "from a conversation", fr: "issue d'une conversation" },
  "learned.tagUnattended": { en: "from an unattended run", fr: "issue d'un run sans surveillance" },
  "learned.tagPending": { en: "not accepted yet", fr: "pas encore acceptée" },
  "learned.pendingHint": {
    en: "Nothing Galactus writes is usable until you accept it. Until then it is in no catalogue, it costs nothing on any turn, and the agent cannot load it. Read it, then accept or reject.",
    fr: "Rien de ce que Galactus écrit n'est utilisable tant que tu ne l'as pas accepté. D'ici là, ce n'est dans aucun catalogue, ça ne coûte rien à aucun tour, et l'agent ne peut pas le charger. Lis, puis accepte ou rejette.",
  },
  "learned.quarantined": {
    en: "Not in use: %s. It stays on disk until you delete it.",
    fr: "Inutilisée : %s. Elle reste sur le disque tant que tu ne la supprimes pas.",
  },
  "learned.read": { en: "Read", fr: "Lire" },
  "learned.approve": { en: "Accept", fr: "Accepter" },
  "learned.reject": { en: "Reject", fr: "Rejeter" },
  "learned.delete": { en: "Delete", fr: "Supprimer" },
  "learned.deleteAll": { en: "Delete everything learned", fr: "Tout supprimer" },
  "learned.folderTitle": { en: "Where they live", fr: "Où elles sont rangées" },
  "learned.folderDesc": {
    en: "A folder of its own. The skills that ship with the app are elsewhere and are never touched.",
    fr: "Un dossier à part. Les skills livrées avec l'app sont ailleurs et ne sont jamais touchées.",
  },
};

// localStorage can throw in restricted webviews, this module runs at import
// time, so an unguarded access would take the whole app down.
function readStoredLang(): Lang {
  try {
    const stored = localStorage.getItem("galactus.lang") as Lang | null;
    if (stored === "fr" || stored === "en") return stored;
  } catch {
    // localStorage can throw in a restricted webview; fall through to the
    // system language rather than taking the whole app down.
  }
  return systemLang();
}

/**
 * The language to start in when nobody has chosen one.
 *
 * It was hard-coded to French. The README is in English, the audience is
 * worldwide, and the language picker lives in a settings page that was itself
 * in French: an English speaker opened the app, read "Comment demarrer
 * Galactus ?", and had to guess their way to a menu they could not read. A
 * first launch should speak the language of the machine it launched on.
 */
function systemLang(): Lang {
  try {
    const nav = (globalThis as unknown as { navigator?: { language?: string; languages?: readonly string[] } }).navigator;
    const tags = [nav?.language, ...(nav?.languages ?? [])];
    for (const tag of tags) {
      if (typeof tag === "string" && tag.toLowerCase().startsWith("fr")) return "fr";
      if (typeof tag === "string" && tag.length > 0) return "en";
    }
  } catch {}
  return "en";
}
let current: Lang = readStoredLang();
export function setLang(l: Lang) { current = l; try { localStorage.setItem("galactus.lang", l); } catch {} }
export function getLang(): Lang { return current; }
export function t(key: string): string { const e = dict[key]; return e ? e[current] : key; }
