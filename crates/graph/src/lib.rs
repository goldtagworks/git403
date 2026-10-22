//! 커밋 그래프 레이아웃.
//!
//! 입력: 부모가 자식보다 뒤에 오는 커밋 목록(`git log --date-order`).
//! 출력: 행마다 노드의 레인(열)과, 다음 행으로 이어지는 선분 목록.
//! 그리기는 UI가 하고, 여기서는 좌표 계산만 한다.

use serde::Serialize;

pub struct Node<'a> {
    pub id: &'a str,
    pub parents: &'a [String],
}

/// `row`의 `from` 레인에서 `row + 1`의 `to` 레인으로 가는 선.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Edge {
    pub from: u16,
    pub to: u16,
    pub color: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct Row {
    pub lane: u16,
    pub color: u16,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Default, Serialize)]
pub struct Layout {
    pub rows: Vec<Row>,
    pub max_lanes: u16,
}

#[derive(Clone)]
struct Slot {
    /// 이 레인이 기다리는 커밋.
    expect: String,
    color: u16,
    /// HEAD 자리로 미리 잡아 둔 레인: 아직 아무 선도 없으므로 그리지 않는다.
    ghost: bool,
}

pub fn layout<'a>(nodes: impl IntoIterator<Item = Node<'a>>) -> Layout {
    layout_with_head(nodes, None)
}

/// `head`(현재 체크아웃한 커밋)가 목록에 있으면 0번 레인을 HEAD에 미리 잡아 둔다 (현재 브랜치가 맨 왼쪽).
/// HEAD보다 위에 오는 다른 브랜치 커밋은 1번 레인부터 쓴다.
pub fn layout_with_head<'a>(nodes: impl IntoIterator<Item = Node<'a>>, head: Option<&str>) -> Layout {
    let nodes: Vec<Node<'a>> = nodes.into_iter().collect();
    let mut lanes: Vec<Option<Slot>> = Vec::new();
    let mut next_color: u16 = 0;
    let mut out = Layout::default();
    let mut fresh_color = || {
        let c = next_color;
        next_color = next_color.wrapping_add(1);
        c
    };
    if let Some(h) = head.filter(|h| nodes.first().is_some_and(|n| n.id != *h) && nodes.iter().any(|n| n.id == *h)) {
        lanes.push(Some(Slot { expect: h.to_owned(), color: fresh_color(), ghost: true }));
    }

    for node in nodes {
        // 1. 이 커밋을 기다리던 레인들. 첫 번째가 노드 위치, 나머지는 여기로 합류한다.
        let waiting: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, s)| s.as_ref().is_some_and(|s| s.expect == node.id))
            .map(|(i, _)| i)
            .collect();

        let (lane, color) = match waiting.first() {
            Some(&i) => (i, lanes[i].as_ref().unwrap().color),
            None => {
                // 브랜치 끝(아무도 기다리지 않던 커밋): 빈 레인을 쓰거나 새로 만든다.
                let i = lanes.iter().position(Option::is_none).unwrap_or_else(|| {
                    lanes.push(None);
                    lanes.len() - 1
                });
                (i, fresh_color())
            }
        };
        for &i in &waiting {
            lanes[i] = None;
        }
        // 이 행에 들어오기 전부터 이어지던 레인 (노드 자신 제외). 이 레인들은 부모가 합류해도 세로선을 끊지 않는다.
        let through: Vec<bool> = lanes.iter().map(Option::is_some).collect();

        // 2. 부모를 레인에 배정한다. 첫 부모는 같은 레인·같은 색을 이어받는다.
        let mut parent_lanes = Vec::with_capacity(node.parents.len());
        // 오른쪽 레인을 왼쪽으로 당겨 온 경우 (원래 레인, 새 레인).
        let mut moved: Vec<(usize, usize)> = Vec::new();
        for (k, parent) in node.parents.iter().enumerate() {
            // 이미 다른 레인이 같은 부모를 기다리면 그쪽으로 합친다.
            if let Some(i) = lanes.iter().position(|s| s.as_ref().is_some_and(|s| &s.expect == parent)) {
                // 첫 부모가 더 오른쪽에서 기다리고 있으면 현재 레인으로 당겨 와서
                // 그래프가 왼쪽으로 모이게 한다.
                if k == 0 && lane < i && lanes[lane].is_none() {
                    let slot = lanes[i].take();
                    let c = slot.as_ref().unwrap().color;
                    lanes[lane] = slot;
                    moved.push((i, lane));
                    parent_lanes.push((lane, c));
                } else {
                    // 다른 레인으로 합류하는 선은 이 브랜치 색으로 그린다.
                    let c = if k == 0 { color } else { lanes[i].as_ref().unwrap().color };
                    if let Some(s) = lanes[i].as_mut() {
                        s.ghost = false; // 누군가 합류했으니 이제부터 선이 있다
                    }
                    parent_lanes.push((i, c));
                }
                continue;
            }
            let (i, c) = if k == 0 {
                (lane, color)
            } else {
                let i = lanes.iter().position(Option::is_none).unwrap_or_else(|| {
                    lanes.push(None);
                    lanes.len() - 1
                });
                (i, fresh_color())
            };
            lanes[i] = Some(Slot { expect: parent.clone(), color: c, ghost: false });
            parent_lanes.push((i, c));
        }

        // 3. 다음 행으로 가는 선: 노드에서 부모 레인으로, 그리고 지나가는 레인들.
        let mut edges: Vec<Edge> = parent_lanes
            .iter()
            .map(|&(to, c)| Edge { from: lane as u16, to: to as u16, color: c })
            .collect();
        for &(from, to) in &moved {
            let c = lanes[to].as_ref().unwrap().color;
            edges.push(Edge { from: from as u16, to: to as u16, color: c });
        }
        for (i, slot) in lanes.iter().enumerate() {
            if let Some(s) = slot.as_ref().filter(|s| !s.ghost) {
                // 노드에서 새로 시작한 부모 레인은 노드에서 나가는 선이 있으니 세로선을 더하지 않는다.
                // 이미 이어지던 레인에 부모가 합류하는 경우는 그 레인의 세로선도 그대로 그린다 (끊기지 않게).
                let was_through = through.get(i).copied().unwrap_or(false);
                let started_here = parent_lanes.iter().any(|&(p, _)| p == i) && !was_through;
                let pulled_in = moved.iter().any(|&(_, to)| to == i);
                if i != lane && !started_here && !pulled_in {
                    edges.push(Edge { from: i as u16, to: i as u16, color: s.color });
                }
            }
        }

        // 오른쪽 끝의 빈 레인은 정리해서 그래프 폭이 계속 늘지 않게 한다.
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }

        out.max_lanes = out.max_lanes.max(lanes.len().max(lane + 1) as u16);
        out.rows.push(Row { lane: lane as u16, color, edges });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(spec: &[(&str, &[&str])]) -> Layout {
        let owned: Vec<(String, Vec<String>)> = spec
            .iter()
            .map(|(id, ps)| (id.to_string(), ps.iter().map(|p| p.to_string()).collect()))
            .collect();
        layout(owned.iter().map(|(id, ps)| Node { id, parents: ps }))
    }

    #[test]
    fn head_gets_lane_zero_even_below_other_branches() {
        // o1·o2는 다른 브랜치(더 최신), h가 HEAD. 둘 다 a에서 갈라졌다.
        let spec: &[(&str, &[&str])] = &[("o2", &["o1"]), ("o1", &["a"]), ("h", &["a"]), ("a", &[])];
        let owned: Vec<(String, Vec<String>)> = spec.iter().map(|(i, p)| (i.to_string(), p.iter().map(|x| x.to_string()).collect())).collect();
        let l = layout_with_head(owned.iter().map(|(id, ps)| Node { id, parents: ps }), Some("h"));
        assert_eq!(l.rows[0].lane, 1);
        assert_eq!(l.rows[2].lane, 0); // HEAD는 맨 왼쪽
        // HEAD 위쪽의 0번 레인은 비어 있다 (선 없음)
        assert!(l.rows[0].edges.iter().all(|e| e.from != 0 && e.to != 0));
        assert_eq!(l.rows[3].lane, 0);
    }

    #[test]
    fn joining_an_existing_lane_keeps_its_line() {
        // x는 레인 1에서 p를 기다린다. 그 뒤 m(레인 0)이 두 번째 부모로 p를 가리키면 레인 1의 세로선이 끊기면 안 된다.
        let l = run(&[("c", &["m"]), ("x", &["p"]), ("m", &["b", "p"]), ("p", &["a"]), ("b", &["a"]), ("a", &[])]);
        assert_eq!(l.rows[2].lane, 0);
        assert!(l.rows[2].edges.contains(&Edge { from: 1, to: 1, color: l.rows[1].color }), "{:?}", l.rows[2].edges);
        assert!(l.rows[2].edges.iter().any(|e| e.from == 0 && e.to == 1));
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        let l = run(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);
        assert!(l.rows.iter().all(|r| r.lane == 0));
        assert_eq!(l.max_lanes, 1);
    }

    #[test]
    fn merge_opens_and_closes_second_lane() {
        // m = merge(b, x); x와 b의 부모는 a
        let l = run(&[("m", &["b", "x"]), ("x", &["a"]), ("b", &["a"]), ("a", &[])]);
        assert_eq!(l.rows[0].lane, 0);
        assert_eq!(l.rows[1].lane, 1); // x는 두 번째 레인
        assert_eq!(l.rows[2].lane, 0);
        assert_eq!(l.rows[3].lane, 0); // a에서 다시 합류
        assert_eq!(l.max_lanes, 2);
        assert_ne!(l.rows[0].color, l.rows[1].color);
    }

    #[test]
    fn two_branch_tips_get_two_lanes() {
        let l = run(&[("f", &["a"]), ("g", &["a"]), ("a", &[])]);
        assert_eq!((l.rows[0].lane, l.rows[1].lane, l.rows[2].lane), (0, 1, 0));
    }
}
