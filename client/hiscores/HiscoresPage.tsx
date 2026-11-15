import React, { useCallback, useEffect, useMemo, useState } from "react";

import "./HiscoresPage.css";
import { BRAND_NAME } from "../config/brand";
import {
    fetchHiscores,
    type HiscoresMeta,
    type HiscoresProfile,
    type HiscoresRank,
    type HiscoresRow,
    type HiscoresTable,
    type TableView,
} from "./hiscoresApi";

/**
 * The website's /hiscores page: our world's rankings, read from the game server's
 * /api/hiscores. It is its own page, so the game client is not loaded here.
 *
 * The layout is the classic hiscores one: game modes across the top, the categories down the
 * left, the table on a scroll in the middle, and the search and compare boxes on the right.
 * Everything is drawn with CSS (HiscoresPage.css); the only pictures are the skill icons the
 * game server sends.
 *
 * What is open lives in the address, so a table or a player can be linked to and the browser's
 * back button works:  ?skill=mining  ?activity=quest-points  ?kills=zulrah  with  &mode=ironman
 * &page=2  or  &rank=140 ;  ?player=kat  for personal scores, and  &vs=sam  to compare.
 * &list=unofficial  on any of them is the unofficial list: everyone in the world, bots included.
 */

type Route = { view: TableView; mode: string; page: number; rank: number; find: string; player: string; vs: string; list: string };

/** The list the address names: the official one unless it says otherwise. */
const listOf = (query: URLSearchParams) => (query.get("list") === "unofficial" ? "unofficial" : "official");

const number = (value: number) => value.toLocaleString("en-US");
const MODE_BADGES: Record<string, string> = { ironman: "IM", hardcore: "HC", ultimate: "UIM" };
const RANK_NAMES: Record<number, string> = { 1: "Moderator", 2: "Administrator", 3: "Owner", 4: "Developer" };
const PAGE_SIZE = 25;

function readRoute(): Route {
    const query = new URLSearchParams(window.location.search);
    const view: TableView = query.has("activity")
        ? { kind: "activity", name: query.get("activity") ?? "" }
        : query.has("kills")
          ? { kind: "kills", name: query.get("kills") ?? "" }
          : { kind: "skill", name: (query.get("skill") ?? "overall").toLowerCase() };
    const rank = Math.max(0, Math.floor(Number(query.get("rank")) || 0));
    return {
        view,
        mode: query.get("mode") ?? "all",
        page: rank > 0 ? Math.ceil(rank / PAGE_SIZE) : Math.max(1, Math.floor(Number(query.get("page")) || 1)),
        rank,
        find: query.get("find") ?? "",
        player: query.get("player") ?? "",
        vs: query.get("vs") ?? "",
        list: listOf(query),
    };
}

function routeUrl(route: Partial<Route>): string {
    const query = new URLSearchParams();
    if (route.player) {
        query.set("player", route.player);
        if (route.vs) query.set("vs", route.vs);
    } else {
        const view = route.view ?? { kind: "skill", name: "overall" };
        if (view.kind !== "skill" || view.name !== "overall") query.set(view.kind, view.name);
        if (route.mode && route.mode !== "all") query.set("mode", route.mode);
        if (route.find) query.set("find", route.find);
        else if (route.rank) query.set("rank", String(route.rank));
        else if (route.page && route.page > 1) query.set("page", String(route.page));
    }
    // A link stays on the list that is open unless it names the other one.
    if ((route.list ?? listOf(new URLSearchParams(window.location.search))) === "unofficial") query.set("list", "unofficial");
    const search = query.toString();
    return `${window.location.pathname}${search ? `?${search}` : ""}`;
}

/** A cup for the first three places, drawn here rather than borrowed. */
function Trophy({ rank }: { rank: number }) {
    if (rank > 3) return <span className="hs-trophy" />;
    return (
        <svg className={`hs-trophy hs-trophy-${rank}`} viewBox="0 0 16 16" aria-label={`Place ${rank}`}>
            <path d="M4 2h8v3a4 4 0 0 1-3 3.870V11h2v2H5v-2h2V8.870A4 4 0 0 1 4 5V2zM1 3h2.500v1H2a1.500 1.500 0 0 0 1.500 1.400v1.100A2.600 2.600 0 0 1 1 4V3zm11.500 0H15v1a2.600 2.600 0 0 1-2.500 2.500V5.400A1.500 1.500 0 0 0 14 4h-1.500V3z" />
        </svg>
    );
}

function PlayerName({ row, onOpen }: { row: Pick<HiscoresRow, "name" | "rights" | "mode" | "dead" | "online">; onOpen?: (name: string) => void }) {
    return (
        <span className="hs-player">
            {onOpen ? (
                <a href={routeUrl({ player: row.name })} onClick={(event) => { event.preventDefault(); onOpen(row.name); }}>{row.name}</a>
            ) : (
                <span>{row.name}</span>
            )}
            {MODE_BADGES[row.mode] && (
                <span className={`hs-badge hs-badge-${row.mode}${row.dead ? " hs-badge-dead" : ""}`} title={row.dead ? "Hardcore Ironman (died)" : undefined}>
                    {MODE_BADGES[row.mode]}
                </span>
            )}
            {RANK_NAMES[row.rights] && <span className="hs-staff">{RANK_NAMES[row.rights]}</span>}
            {row.online && <span className="hs-online" title="Online now">online</span>}
        </span>
    );
}

export default function HiscoresPage(): JSX.Element {
    const [route, setRoute] = useState<Route>(readRoute);
    const [meta, setMeta] = useState<HiscoresMeta | null>(null);
    const [table, setTable] = useState<HiscoresTable | null>(null);
    const [profile, setProfile] = useState<HiscoresProfile | null>(null);
    const [rival, setRival] = useState<HiscoresProfile | null>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
    const [nameSearch, setNameSearch] = useState("");
    const [rankSearch, setRankSearch] = useState("");
    const [compare, setCompare] = useState<[string, string]>(["", ""]);

    // The game's own stylesheet locks the page for the game canvas: no scrolling, no text selection.
    useEffect(() => {
        document.documentElement.classList.add("hs-document");
        document.title = `Hiscores - ${BRAND_NAME}`;
        return () => document.documentElement.classList.remove("hs-document");
    }, []);

    const go = useCallback((next: Partial<Route>) => {
        window.history.pushState(null, "", routeUrl(next));
        setRoute(readRoute());
        window.scrollTo({ top: 0 });
    }, []);

    useEffect(() => {
        const onPop = () => setRoute(readRoute());
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    useEffect(() => {
        const abort = new AbortController();
        fetchHiscores<HiscoresMeta>({ list: route.list }, abort.signal).then((result) => setMeta(result), () => setStatus("error"));
        return () => abort.abort();
    }, [route.list]);

    useEffect(() => {
        const abort = new AbortController();
        setStatus("loading");
        const person = (name: string) => fetchHiscores<HiscoresProfile>({ view: "player", name, list: route.list }, abort.signal);
        const request: Promise<boolean> = route.player
            ? Promise.all([person(route.player), route.vs ? person(route.vs) : Promise.resolve(null)]).then(([first, second]) => {
                  setProfile(first);
                  setRival(second);
                  return first !== null && (!route.vs || second !== null);
              })
            : fetchHiscores<HiscoresTable>(
                  { view: route.view.kind, name: route.view.name, mode: route.mode === "all" ? undefined : route.mode, page: route.page, find: route.find || undefined, list: route.list },
                  abort.signal,
              ).then((result) => {
                  setTable(result);
                  return result !== null;
              });
        request.then(
            (found) => setStatus(found ? "ready" : "missing"),
            (error) => { if (error?.name !== "AbortError") setStatus("error"); },
        );
        return () => abort.abort();
    }, [route]);

    const title = useMemo(() => {
        if (route.view.kind === "skill") {
            if (route.view.name === "overall") return "Overall";
            return meta?.skills.find((skill) => skill.name.toLowerCase() === route.view.name)?.name ?? route.view.name;
        }
        if (route.view.kind === "activity") return meta?.activities.find((activity) => activity.key === route.view.name)?.name ?? route.view.name;
        return meta?.monsters.find((monster) => monster.toLowerCase() === route.view.name.toLowerCase()) ?? route.view.name;
    }, [meta, route.view]);

    const scoreLabel = route.view.kind === "skill" ? "XP" : route.view.kind === "kills" ? "Kills" : "Score";
    const isView = (kind: TableView["kind"], name: string) => !route.player && route.view.kind === kind && route.view.name.toLowerCase() === name.toLowerCase();
    const openTable = (view: TableView) => go({ view, mode: route.mode });
    const openPlayer = (name: string) => go({ player: name });
    const icon = (name: string) => meta?.skills.find((skill) => skill.name === name)?.icon ?? null;
    const modeName = route.mode === "all" ? "" : meta?.modes.find((mode) => mode.key === route.mode)?.name ?? "";
    const unofficial = route.list === "unofficial";
    const highlighted = (row: HiscoresRow) => (route.find && row.name.toLowerCase() === route.find.toLowerCase()) || (route.rank > 0 && row.rank === route.rank);

    const category = (view: TableView, label: string, image?: string | null) => (
        <a
            key={`${view.kind}:${view.name}`}
            className={isView(view.kind, view.name) ? "hs-on" : ""}
            href={routeUrl({ view, mode: route.mode })}
            onClick={(event) => { event.preventDefault(); openTable(view); }}
        >
            {image ? <img src={image} alt="" /> : <span className="hs-noicon" />}
            {label}
        </a>
    );

    /**
     * One line of personal scores: what it is (a link to its table, opened where this player is)
     * and their numbers; an activity or a monster has no level, so that column stays empty.
     */
    const scoreLine = (rank: HiscoresRank, view: TableView, withLevel: boolean, other?: HiscoresRank) => {
        const better = (mine: number, theirs: number | undefined) => (other && theirs !== undefined && mine > theirs ? "hs-num hs-better" : "hs-num");
        return (
            <tr key={`${view.kind}:${view.name}`}>
                <td className="hs-skill">
                    {withLevel && icon(rank.name) ? <img src={icon(rank.name)!} alt="" /> : <span className="hs-noicon" />}
                    <a href={routeUrl({ view, find: profile?.name })} onClick={(event) => { event.preventDefault(); go({ view, find: profile?.name }); }}>{rank.name}</a>
                </td>
                <td className="hs-num">{rank.rank ? number(rank.rank) : "--"}</td>
                {withLevel ? <td className={better(rank.level ?? 1, other?.level)}>{number(rank.level ?? 1)}</td> : <td />}
                <td className={better(rank.score, other?.score)}>{number(rank.score)}</td>
                {other && (
                    <>
                        <td className="hs-num hs-gap">{other.rank ? number(other.rank) : "--"}</td>
                        {withLevel ? <td className={better(other.level ?? 1, rank.level)}>{number(other.level ?? 1)}</td> : <td />}
                        <td className={better(other.score, rank.score)}>{number(other.score)}</td>
                    </>
                )}
            </tr>
        );
    };
    const comparing = Boolean(route.vs && rival);
    const versus = (list: HiscoresRank[] | undefined, name: string) => (comparing ? list?.find((item) => item.name === name) ?? { name, rank: null, score: 0 } : undefined);

    return (
        <div className="hs-page">
            <header className="hs-header">
                <div className="hs-masthead">
                    <h1>{meta?.world ? `${meta.world} Hiscores` : "Hiscores"}</h1>
                    <a href="/">Play now</a>
                </div>
                <nav className="hs-lists" aria-label="Lists">
                    {(meta?.lists ?? [{ key: "official", name: "Official", players: 0 }, { key: "unofficial", name: "Unofficial", players: 0 }]).map((list) => (
                        <button
                            key={list.key}
                            className={route.list === list.key ? "hs-on" : ""}
                            title={list.key === "unofficial" ? "Everyone in the world, bots included" : "Players only"}
                            onClick={() => go({ view: route.view, mode: route.mode, list: list.key })}
                        >
                            {list.name}
                        </button>
                    ))}
                </nav>
                <nav className="hs-modes" aria-label="Game modes">
                    {[{ key: "all", name: "Hiscores" }, ...(meta?.modes ?? [])].map((mode) => (
                        <button key={mode.key} className={!route.player && route.mode === mode.key ? "hs-on" : ""} onClick={() => go({ view: route.view, mode: mode.key })}>
                            {mode.name}
                        </button>
                    ))}
                </nav>
            </header>

            <div className="hs-body">
                <nav className="hs-categories" aria-label="Categories">
                    <h2>Category</h2>
                    <div className="hs-category-list">
                        {category({ kind: "skill", name: "overall" }, "Overall")}
                        {meta?.skills.map((skill) => category({ kind: "skill", name: skill.name.toLowerCase() }, skill.name, skill.icon))}
                        <span className="hs-rule">----</span>
                        {meta?.activities.map((activity) => category({ kind: "activity", name: activity.key }, activity.name))}
                        {(meta?.monsters.length ?? 0) > 0 && <span className="hs-rule">----</span>}
                        {meta?.monsters.map((monster) => category({ kind: "kills", name: monster }, monster))}
                    </div>
                </nav>

                <main className="hs-scroll">
                    <div className="hs-scroll-end" />
                    <div className="hs-parchment">
                        {status === "error" && <p className="hs-note">The hiscores can't be reached right now. The game server may be restarting; try again in a minute.</p>}

                        {!route.player && status !== "error" && (
                            <>
                                <h2>{modeName ? `${title} Hiscores: ${modeName}` : `${title} Hiscores`}</h2>
                                {unofficial && <p className="hs-pageline">Unofficial list: everyone in the world, bots included.</p>}
                                {status === "missing" && <p className="hs-note">There is no table called "{route.view.name}".</p>}
                                {table && status !== "missing" && (
                                    <div className="hs-tablewrap">
                                        <table className="hs-table">
                                            <thead>
                                                <tr>
                                                    <th />
                                                    <th className="hs-num">Rank</th>
                                                    <th>Name</th>
                                                    {route.view.kind === "skill" && <th className="hs-num">Level</th>}
                                                    <th className="hs-num">{scoreLabel}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {table.rows.map((row) => (
                                                    <tr key={row.name} className={highlighted(row) ? "hs-found" : ""}>
                                                        <td><Trophy rank={row.rank} /></td>
                                                        <td className="hs-num">{number(row.rank)}</td>
                                                        <td><PlayerName row={row} onOpen={openPlayer} /></td>
                                                        {route.view.kind === "skill" && <td className="hs-num">{number(row.level ?? 1)}</td>}
                                                        <td className="hs-num">{number(row.score)}</td>
                                                    </tr>
                                                ))}
                                                {table.rows.length === 0 && (
                                                    <tr><td colSpan={5} className="hs-none">Nobody is ranked here yet.</td></tr>
                                                )}
                                            </tbody>
                                        </table>
                                        <div className="hs-arrows">
                                            <button disabled={table.page <= 1} title="Previous page" aria-label="Previous page" onClick={() => go({ view: route.view, mode: route.mode, page: table.page - 1 })}>&#9650;</button>
                                            <button disabled={table.page >= table.pages} title="Next page" aria-label="Next page" onClick={() => go({ view: route.view, mode: route.mode, page: table.page + 1 })}>&#9660;</button>
                                        </div>
                                    </div>
                                )}
                                {table && table.pages > 1 && status !== "missing" && <p className="hs-pageline">Page {number(table.page)} of {number(table.pages)}</p>}
                            </>
                        )}

                        {route.player && status === "missing" && (
                            <p className="hs-note">
                                No player called "{!profile ? route.player : route.vs}" is ranked{unofficial ? "" : " on the official list"}. A new player appears here after their first save: when they log out, or a few minutes into playing.
                            </p>
                        )}
                        {route.player && profile && status !== "missing" && status !== "error" && (
                            <>
                                <h2>
                                    {comparing ? <>Comparing <PlayerName row={profile} onOpen={openPlayer} /> and <PlayerName row={rival!} onOpen={openPlayer} /></> : <>Personal scores for <PlayerName row={profile} /></>}
                                </h2>
                                {!comparing && <p className="hs-pageline">Combat level {number(profile.combat)}{unofficial ? " (ranks on the unofficial list)" : ""}</p>}
                                <table className="hs-table hs-personal">
                                    <thead>
                                        {comparing && (
                                            <tr className="hs-names"><th /><th colSpan={3}>{profile.name}</th><th colSpan={3} className="hs-gap">{rival!.name}</th></tr>
                                        )}
                                        <tr>
                                            <th>Skill</th><th className="hs-num">Rank</th><th className="hs-num">Level</th><th className="hs-num">XP</th>
                                            {comparing && <><th className="hs-num hs-gap">Rank</th><th className="hs-num">Level</th><th className="hs-num">XP</th></>}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {scoreLine({ name: "Overall", ...profile.overall }, { kind: "skill", name: "overall" }, true, comparing ? { name: "Overall", ...rival!.overall } : undefined)}
                                        {profile.skills.map((skill) => scoreLine(skill, { kind: "skill", name: skill.name.toLowerCase() }, true, versus(rival?.skills, skill.name)))}
                                    </tbody>
                                    <thead>
                                        <tr>
                                            <th>Activity</th><th className="hs-num">Rank</th><th /><th className="hs-num">Score</th>
                                            {comparing && <><th className="hs-num hs-gap">Rank</th><th /><th className="hs-num">Score</th></>}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {profile.activities.map((activity) => scoreLine(activity, { kind: "activity", name: activity.key ?? "" }, false, versus(rival?.activities, activity.name)))}
                                    </tbody>
                                    {(profile.kills.length > 0 || (comparing && rival!.kills.length > 0)) && (
                                        <>
                                            <thead>
                                                <tr>
                                                    <th>Kills</th><th className="hs-num">Rank</th><th /><th className="hs-num">Kills</th>
                                                    {comparing && <><th className="hs-num hs-gap">Rank</th><th /><th className="hs-num">Kills</th></>}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {[...new Set([...profile.kills, ...(comparing ? rival!.kills : [])].map((kill) => kill.name))].map((monster) =>
                                                    scoreLine(
                                                        profile.kills.find((kill) => kill.name === monster) ?? { name: monster, rank: null, score: 0 },
                                                        { kind: "kills", name: monster },
                                                        false,
                                                        versus(rival?.kills, monster),
                                                    ),
                                                )}
                                            </tbody>
                                        </>
                                    )}
                                </table>
                            </>
                        )}
                    </div>
                    <div className="hs-scroll-end" />
                </main>

                <aside className="hs-side">
                    <form
                        className="hs-box"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (nameSearch.trim()) openPlayer(nameSearch.trim());
                        }}
                    >
                        <h3>Search by name</h3>
                        <input value={nameSearch} onChange={(event) => setNameSearch(event.target.value)} maxLength={20} aria-label="Player name" />
                        <button type="submit">Search</button>
                    </form>
                    <form
                        className="hs-box"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const rank = Math.floor(Number(rankSearch.replace(/[^0-9]/g, "")));
                            if (rank > 0) go({ view: route.view, mode: route.mode, rank });
                        }}
                    >
                        <h3>Search by rank</h3>
                        <input value={rankSearch} onChange={(event) => setRankSearch(event.target.value)} maxLength={9} inputMode="numeric" aria-label="Rank" />
                        <button type="submit">Search</button>
                    </form>
                    <form
                        className="hs-box"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (compare[0].trim() && compare[1].trim()) go({ player: compare[0].trim(), vs: compare[1].trim() });
                        }}
                    >
                        <h3>Compare Users</h3>
                        <input value={compare[0]} onChange={(event) => setCompare([event.target.value, compare[1]])} maxLength={20} aria-label="First player" />
                        <input value={compare[1]} onChange={(event) => setCompare([compare[0], event.target.value])} maxLength={20} aria-label="Second player" />
                        <button type="submit">Compare</button>
                    </form>
                    <div className="hs-box">
                        <h3>{meta?.world || "Our world"}</h3>
                        <p>{meta ? `${number(meta.players)} ${meta.players === 1 ? "player" : "players"} ranked${unofficial ? ", bots included" : ""}` : " "}</p>
                        <p>{meta ? `${number(meta.online)} online now` : " "}</p>
                        <a href="/">Play now</a>
                    </div>
                </aside>
            </div>

            <footer className="hs-footer">
                Ranks update when the game saves a player: at logout, and every few minutes while playing.
                <br />
                Edited and hosted for free by kat-net.us
            </footer>
        </div>
    );
}
