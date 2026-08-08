// Bilingual dictionary. Both languages ship in v1.
export type Lang = "en" | "fr";

const dict: Record<string, { en: string; fr: string }> = {
  "brand.by": { en: "by Noxalis Lab · v0.1", fr: "par Noxalis Lab · v0.1" },
  "nav.chat": { en: "Chat", fr: "Discussion" },
  "nav.models": { en: "Models", fr: "Modèles" },
  "nav.connectors": { en: "Connectors", fr: "Connecteurs" },
  "nav.memory": { en: "Memory", fr: "Mémoire" },
  "nav.agent": { en: "Agent", fr: "Agent" },
  "nav.settings": { en: "Settings", fr: "Réglages" },

  "chat.placeholder": { en: "Message Galactus… (⇧⏎ for a new line)", fr: "Écrire à Galactus… (⇧⏎ pour un saut de ligne)" },
  "chat.noserver": { en: "Start a model in Models to begin.", fr: "Démarre un modèle dans Modèles pour commencer." },
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
  "tool.osearch": { en: "Search vault", fr: "Chercher dans le coffre" },
  "tool.oread": { en: "Read note", fr: "Lire la note" },
  "tool.owrite": { en: "Write note", fr: "Écrire la note" },
  "tool.oupdate": { en: "Rewrite note", fr: "Réécrire la note" },
  "tool.spawnAgent": { en: "Recruit a sub-agent", fr: "Recruter un sous-agent" },
  "tool.listAgents": { en: "List the team", fr: "Lister l'équipe" },
  "tool.askAgent": { en: "Ask a teammate", fr: "Demander à un coéquipier" },
  "tool.convSearch": { en: "Search the conversations", fr: "Chercher dans les discussions" },
  "tool.convRead": { en: "Read a conversation", fr: "Lire une discussion" },

  "models.subtitle": { en: "Certified on the Galactus engine", fr: "Certifiés sur le moteur Galactus" },
  "models.certified": { en: "certified", fr: "certifié" },
  "models.onThisMac": { en: "on this Mac", fr: "sur ce Mac" },
  "models.download": { en: "Install", fr: "Installer" },
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

  "preview.title": { en: "Preview", fr: "Aperçu" },
  "preview.refresh": { en: "Refresh", fr: "Rafraîchir" },
  "preview.openBrowser": { en: "Open in browser", fr: "Ouvrir dans le navigateur" },
  "preview.close": { en: "Close", fr: "Fermer" },
  "preview.copied": { en: "copied", fr: "copié" },
  "preview.mermaidMissing": {
    en: "Mermaid renderer not available. Showing the diagram source.",
    fr: "Rendu Mermaid indisponible. Voici la source du diagramme.",
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
};

// localStorage can throw in restricted webviews — this module runs at import
// time, so an unguarded access would take the whole app down.
function readStoredLang(): Lang {
  try { return (localStorage.getItem("galactus.lang") as Lang) || "fr"; } catch { return "fr"; }
}
let current: Lang = readStoredLang();
export function setLang(l: Lang) { current = l; try { localStorage.setItem("galactus.lang", l); } catch {} }
export function getLang(): Lang { return current; }
export function t(key: string): string { const e = dict[key]; return e ? e[current] : key; }
