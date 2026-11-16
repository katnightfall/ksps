/**
 * Ours. The front page of the site: the way in to the game (/play), the worlds we list with who
 * is on them, and the hiscores. The game client is not loaded here (index.tsx).
 */
import React, { useEffect, useState } from "react";

import { BRAND_NAME } from "../config/brand";
import "./LandingPage.css";
import { fetchWorlds, playersText, type LandingWorld } from "./landingApi";

/** How often the list of worlds is asked for again while the page is open. */
const REFRESH_MS = 30_000;

function WorldRow({ world }: { world: LandingWorld }): JSX.Element {
    const rate = world.experienceRate && world.experienceRate !== 1 ? `${world.experienceRate}x experience` : world.experienceRate === 1 ? "1x experience" : "";
    const facts = [rate, world.bots ? `${world.bots.toLocaleString("en-US")} bots` : ""].filter(Boolean).join(" · ");
    return (
        <li className={`lp-world${world.online ? "" : " lp-world-off"}`}>
            <span className={`lp-dot${world.online ? " lp-dot-on" : ""}`} aria-hidden="true" />
            <div className="lp-world-text">
                <div className="lp-world-name">
                    {world.name}
                    {world.here && <span className="lp-tag">this world</span>}
                </div>
                {world.description && <div className="lp-world-about">{world.description}</div>}
                {facts && <div className="lp-world-facts">{facts}</div>}
            </div>
            <div className="lp-world-count">{playersText(world)}</div>
            <div className="lp-world-links">
                <a className="lp-button lp-button-small" href={world.play}>Play</a>
                <a className="lp-link" href={world.hiscores}>Hiscores</a>
            </div>
        </li>
    );
}

export default function LandingPage(): JSX.Element {
    const [worlds, setWorlds] = useState<LandingWorld[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        document.documentElement.classList.add("lp-document");
        return () => document.documentElement.classList.remove("lp-document");
    }, []);

    useEffect(() => {
        const abort = new AbortController();
        let timer: number | undefined;
        const load = () => {
            fetchWorlds(abort.signal)
                .then((list) => { setWorlds(list); setFailed(false); })
                .catch(() => { if (!abort.signal.aborted) setFailed(true); })
                .finally(() => { if (!abort.signal.aborted) timer = window.setTimeout(load, REFRESH_MS); });
        };
        load();
        return () => { abort.abort(); window.clearTimeout(timer); };
    }, []);

    const here = worlds?.find((world) => world.here);
    const name = here?.name || BRAND_NAME;
    const about = here?.description ?? "";
    useEffect(() => { document.title = name; }, [name]);

    const people = (worlds ?? []).reduce((sum, world) => sum + (world.players ?? 0), 0);
    const up = (worlds ?? []).filter((world) => world.online).length;

    return (
        <div className="lp-page">
            <header className="lp-header">
                <div className="lp-masthead">
                    <h1>{name}</h1>
                    {about && <p>{about}</p>}
                </div>
                <div className="lp-actions">
                    <a className="lp-button lp-button-main" href="/play">Play now</a>
                    <a className="lp-button" href="/hiscores">Hiscores</a>
                </div>
                <p className="lp-note">Plays in your browser. Nothing to download.</p>
            </header>

            <main className="lp-main">
                <section className="lp-panel" aria-labelledby="lp-worlds">
                    <div className="lp-panel-head">
                        <h2 id="lp-worlds">Worlds</h2>
                        {worlds && worlds.length > 0 && (
                            <span className="lp-panel-sum">
                                {up} of {worlds.length} online · {people.toLocaleString("en-US")} {people === 1 ? "player" : "players"} now
                            </span>
                        )}
                    </div>
                    {worlds === null && !failed && <p className="lp-quiet">Looking for worlds…</p>}
                    {worlds === null && failed && <p className="lp-quiet">The world list is not answering right now. The game itself may still be up: try Play now.</p>}
                    {worlds !== null && worlds.length === 0 && <p className="lp-quiet">No worlds are listed yet.</p>}
                    {worlds !== null && worlds.length > 0 && (
                        <ul className="lp-worlds">
                            {worlds.map((world) => <WorldRow key={world.id} world={world} />)}
                        </ul>
                    )}
                    {worlds !== null && worlds.length > 1 && (
                        <p className="lp-quiet lp-foot">You can also change world from the game's login screen.</p>
                    )}
                </section>
            </main>

            <footer className="lp-footer">
                <a href="/play">Play</a>
                <span aria-hidden="true">·</span>
                <a href="/hiscores">Hiscores</a>
            </footer>
        </div>
    );
}
