//! 최적화 전 레이아웃 구현(참조). 새 구현과 결과가 바이트 단위로 같은지 비교하는 테스트 전용.
use crate::{Edge, Layout, Node, Row};

#[derive(Clone)]
struct Slot {
    /// 이 레인이 기다리는 커밋.
    expect: String,
    color: u16,
    /// HEAD 자리로 미리 잡아 둔 레인: 아직 아무 선도 없으므로 그리지 않는다.
    ghost: bool,
}

pub(crate) fn layout_with_head<'a>(nodes: impl IntoIterator<Item = Node<'a>>, head: Option<&str>) -> Layout {
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

